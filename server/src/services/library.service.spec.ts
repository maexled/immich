import { BadRequestException } from '@nestjs/common';
import { Stats } from 'node:fs';
import { SystemConfig } from 'src/config';
import { SystemConfigCore } from 'src/cores/system-config.core';
import { AssetTrashReason } from 'src/dtos/asset.dto';
import { mapLibrary } from 'src/dtos/library.dto';
import { UserEntity } from 'src/entities/user.entity';
import { AssetType } from 'src/enum';
import { IAssetRepository } from 'src/interfaces/asset.interface';
import { ICryptoRepository } from 'src/interfaces/crypto.interface';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import {
  IJobRepository,
  ILibraryFileJob,
  ILibraryOfflineJob,
  JobName,
  JOBS_LIBRARY_PAGINATION_SIZE,
  JobStatus,
} from 'src/interfaces/job.interface';
import { ILibraryRepository } from 'src/interfaces/library.interface';
import { ILoggerRepository } from 'src/interfaces/logger.interface';
import { IStorageRepository } from 'src/interfaces/storage.interface';
import { ISystemMetadataRepository } from 'src/interfaces/system-metadata.interface';
import { LibraryService } from 'src/services/library.service';
import { assetStub } from 'test/fixtures/asset.stub';
import { authStub } from 'test/fixtures/auth.stub';
import { libraryStub } from 'test/fixtures/library.stub';
import { systemConfigStub } from 'test/fixtures/system-config.stub';
import { userStub } from 'test/fixtures/user.stub';
import { newAssetRepositoryMock } from 'test/repositories/asset.repository.mock';
import { newCryptoRepositoryMock } from 'test/repositories/crypto.repository.mock';
import { newDatabaseRepositoryMock } from 'test/repositories/database.repository.mock';
import { newJobRepositoryMock } from 'test/repositories/job.repository.mock';
import { newLibraryRepositoryMock } from 'test/repositories/library.repository.mock';
import { newLoggerRepositoryMock } from 'test/repositories/logger.repository.mock';
import { makeMockWatcher, newStorageRepositoryMock } from 'test/repositories/storage.repository.mock';
import { newSystemMetadataRepositoryMock } from 'test/repositories/system-metadata.repository.mock';
import { Mocked, vitest } from 'vitest';

describe(LibraryService.name, () => {
  let sut: LibraryService;

  let assetMock: Mocked<IAssetRepository>;
  let systemMock: Mocked<ISystemMetadataRepository>;
  let cryptoMock: Mocked<ICryptoRepository>;
  let jobMock: Mocked<IJobRepository>;
  let libraryMock: Mocked<ILibraryRepository>;
  let storageMock: Mocked<IStorageRepository>;
  let databaseMock: Mocked<IDatabaseRepository>;
  let loggerMock: Mocked<ILoggerRepository>;

  beforeEach(() => {
    systemMock = newSystemMetadataRepositoryMock();
    libraryMock = newLibraryRepositoryMock();
    assetMock = newAssetRepositoryMock();
    jobMock = newJobRepositoryMock();
    cryptoMock = newCryptoRepositoryMock();
    storageMock = newStorageRepositoryMock();
    databaseMock = newDatabaseRepositoryMock();
    loggerMock = newLoggerRepositoryMock();

    sut = new LibraryService(
      assetMock,
      systemMock,
      cryptoMock,
      jobMock,
      libraryMock,
      storageMock,
      databaseMock,
      loggerMock,
    );

    databaseMock.tryLock.mockResolvedValue(true);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onBootstrapEvent', () => {
    it('should init cron job and subscribe to config changes', async () => {
      systemMock.get.mockResolvedValue(systemConfigStub.libraryScan);

      await sut.onBootstrap();
      expect(systemMock.get).toHaveBeenCalled();
      expect(jobMock.addCronJob).toHaveBeenCalled();

      SystemConfigCore.create(newSystemMetadataRepositoryMock(false), newLoggerRepositoryMock()).config$.next({
        library: {
          scan: {
            enabled: true,
            cronExpression: '0 1 * * *',
          },
          watch: { enabled: false },
        },
      } as SystemConfig);

      expect(jobMock.updateCronJob).toHaveBeenCalledWith('libraryScan', '0 1 * * *', true);
    });

    it('should initialize watcher for all external libraries', async () => {
      libraryMock.getAll.mockResolvedValue([
        libraryStub.externalLibraryWithImportPaths1,
        libraryStub.externalLibraryWithImportPaths2,
      ]);

      systemMock.get.mockResolvedValue(systemConfigStub.libraryWatchEnabled);
      libraryMock.get.mockImplementation((id) =>
        Promise.resolve(
          [libraryStub.externalLibraryWithImportPaths1, libraryStub.externalLibraryWithImportPaths2].find(
            (library) => library.id === id,
          ) || null,
        ),
      );

      await sut.onBootstrap();

      expect(storageMock.watch.mock.calls).toEqual(
        expect.arrayContaining([
          (libraryStub.externalLibrary1.importPaths, expect.anything()),
          (libraryStub.externalLibrary2.importPaths, expect.anything()),
        ]),
      );
    });

    it('should not initialize watcher when watching is disabled', async () => {
      systemMock.get.mockResolvedValue(systemConfigStub.libraryWatchDisabled);

      await sut.onBootstrap();

      expect(storageMock.watch).not.toHaveBeenCalled();
    });

    it('should not initialize watcher when lock is taken', async () => {
      systemMock.get.mockResolvedValue(systemConfigStub.libraryWatchEnabled);
      databaseMock.tryLock.mockResolvedValue(false);

      await sut.onBootstrap();

      expect(storageMock.watch).not.toHaveBeenCalled();
    });
  });

  describe('onConfigValidateEvent', () => {
    it('should allow a valid cron expression', () => {
      expect(() =>
        sut.onConfigValidate({
          newConfig: { library: { scan: { cronExpression: '0 0 * * *' } } } as SystemConfig,
          oldConfig: {} as SystemConfig,
        }),
      ).not.toThrow(expect.stringContaining('Invalid cron expression'));
    });

    it('should fail for an invalid cron expression', () => {
      expect(() =>
        sut.onConfigValidate({
          newConfig: { library: { scan: { cronExpression: 'foo' } } } as SystemConfig,
          oldConfig: {} as SystemConfig,
        }),
      ).toThrow(/Invalid cron expression.*/);
    });
  });

  describe('handleQueueAssetRefresh', () => {
    it('should queue refresh of a new asset', async () => {
      assetMock.getWith.mockResolvedValue({ items: [], hasNextPage: false });

      libraryMock.get.mockResolvedValue(libraryStub.externalLibrary1);
      // eslint-disable-next-line @typescript-eslint/require-await
      storageMock.walk.mockImplementation(async function* generator() {
        yield ['/data/user1/photo.jpg'];
      });
      assetMock.getExternalLibraryAssetPaths.mockResolvedValue({ items: [], hasNextPage: false });

      await sut.handleQueueAssetRefresh({ id: libraryStub.externalLibrary1.id });

      expect(jobMock.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.LIBRARY_SCAN_ASSET,
          data: {
            id: libraryStub.externalLibrary1.id,
            ownerId: libraryStub.externalLibrary1.owner.id,
            assetPath: '/data/user1/photo.jpg',
          },
        },
      ]);
    });

    it("should fail when library can't be found", async () => {
      libraryMock.get.mockResolvedValue(null);

      await expect(sut.handleQueueAssetRefresh({ id: libraryStub.externalLibrary1.id })).resolves.toBe(
        JobStatus.SKIPPED,
      );
    });

    it('should ignore import paths that do not exist', async () => {
      storageMock.stat.mockImplementation((path): Promise<Stats> => {
        if (path === libraryStub.externalLibraryWithImportPaths1.importPaths[0]) {
          const error = { code: 'ENOENT' } as any;
          throw error;
        }
        return Promise.resolve({
          isDirectory: () => true,
        } as Stats);
      });

      storageMock.checkFileExists.mockResolvedValue(true);

      assetMock.getWith.mockResolvedValue({ items: [], hasNextPage: false });

      libraryMock.get.mockResolvedValue(libraryStub.externalLibraryWithImportPaths1);
      assetMock.getExternalLibraryAssetPaths.mockResolvedValue({ items: [], hasNextPage: false });

      await sut.handleQueueAssetRefresh({ id: libraryStub.externalLibraryWithImportPaths1.id });

      expect(storageMock.walk).toHaveBeenCalledWith({
        pathsToCrawl: [libraryStub.externalLibraryWithImportPaths1.importPaths[1]],
        exclusionPatterns: [],
        includeHidden: false,
        take: JOBS_LIBRARY_PAGINATION_SIZE,
      });
    });
  });

  describe('handleQueueRemoveDeleted', () => {
    it('should queue online check of existing assets', async () => {
      libraryMock.get.mockResolvedValue(libraryStub.externalLibrary1);
      storageMock.walk.mockImplementation(async function* generator() {});
      assetMock.getAll.mockResolvedValue({ items: [assetStub.external], hasNextPage: false });

      await sut.handleQueueAssetOfflineCheck({ id: libraryStub.externalLibrary1.id });

      expect(jobMock.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.LIBRARY_OFFLINE_CHECK,
          data: {
            id: assetStub.external.id,
            importPaths: libraryStub.externalLibrary1.importPaths,
            exclusionPatterns: [],
          },
        },
      ]);
    });

    it("should fail when library can't be found", async () => {
      libraryMock.get.mockResolvedValue(null);

      await expect(sut.handleQueueAssetOfflineCheck({ id: libraryStub.externalLibrary1.id })).resolves.toBe(
        JobStatus.SKIPPED,
      );
    });
  });

  describe('handleAssetOfflineCheck', () => {
    it('should skip missing assets', async () => {
      const mockAssetJob: ILibraryOfflineJob = {
        id: assetStub.external.id,
        importPaths: ['/'],
        exclusionPatterns: [],
      };

      assetMock.getById.mockResolvedValue(null);

      await expect(sut.handleAssetOfflineCheck(mockAssetJob)).resolves.toBe(JobStatus.SKIPPED);

      expect(assetMock.remove).not.toHaveBeenCalled();
    });

    it('should offline assets no longer on disk', async () => {
      const mockAssetJob: ILibraryOfflineJob = {
        id: assetStub.external.id,
        importPaths: ['/'],
        exclusionPatterns: [],
      };

      assetMock.getById.mockResolvedValue(assetStub.external);

      await expect(sut.handleAssetOfflineCheck(mockAssetJob)).resolves.toBe(JobStatus.SUCCESS);

      expect(assetMock.updateAll).toHaveBeenCalledWith([assetStub.external.id], {
        trashReason: AssetTrashReason.OFFLINE,
      });
      expect(assetMock.softDeleteAll).toHaveBeenCalledWith([assetStub.external.id]);
    });

    it('should offline assets matching an exclusion pattern', async () => {
      const mockAssetJob: ILibraryOfflineJob = {
        id: assetStub.external.id,
        importPaths: ['/'],
        exclusionPatterns: ['**/user1/**'],
      };

      assetMock.getById.mockResolvedValue(assetStub.external);

      await expect(sut.handleAssetOfflineCheck(mockAssetJob)).resolves.toBe(JobStatus.SUCCESS);
      expect(assetMock.updateAll).toHaveBeenCalledWith([assetStub.external.id], {
        trashReason: AssetTrashReason.OFFLINE,
      });
      expect(assetMock.softDeleteAll).toHaveBeenCalledWith([assetStub.external.id]);
    });

    it('should set assets outside of import paths as offline', async () => {
      const mockAssetJob: ILibraryOfflineJob = {
        id: assetStub.external.id,
        importPaths: ['/data/user2'],
        exclusionPatterns: [],
      };

      assetMock.getById.mockResolvedValue(assetStub.external);
      storageMock.checkFileExists.mockResolvedValue(true);

      await expect(sut.handleAssetOfflineCheck(mockAssetJob)).resolves.toBe(JobStatus.SUCCESS);

      expect(assetMock.updateAll).toHaveBeenCalledWith([assetStub.external.id], {
        trashReason: AssetTrashReason.OFFLINE,
      });
      expect(assetMock.softDeleteAll).toHaveBeenCalledWith([assetStub.external.id]);
    });

    it('should do nothing with online assets', async () => {
      const mockAssetJob: ILibraryOfflineJob = {
        id: assetStub.external.id,
        importPaths: ['/'],
        exclusionPatterns: [],
      };

      assetMock.getById.mockResolvedValue(assetStub.external);
      storageMock.checkFileExists.mockResolvedValue(true);

      await expect(sut.handleAssetOfflineCheck(mockAssetJob)).resolves.toBe(JobStatus.SUCCESS);

      expect(assetMock.remove).not.toHaveBeenCalled();
    });
  });

  describe('handleAssetRefresh', () => {
    let mockUser: UserEntity;

    beforeEach(() => {
      mockUser = userStub.admin;

      storageMock.stat.mockResolvedValue({
        size: 100,
        mtime: new Date('2023-01-01'),
        ctime: new Date('2023-01-01'),
      } as Stats);
    });

    it('should reject an unknown file extension', async () => {
      const mockLibraryJob: ILibraryFileJob = {
        id: libraryStub.externalLibrary1.id,
        ownerId: mockUser.id,
        assetPath: '/data/user1/file.xyz',
      };

      assetMock.getByLibraryIdAndOriginalPath.mockResolvedValue(null);

      await expect(sut.handleAssetRefresh(mockLibraryJob)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should reject an unknown file type', async () => {
      const mockLibraryJob: ILibraryFileJob = {
        id: libraryStub.externalLibrary1.id,
        ownerId: mockUser.id,
        assetPath: '/data/user1/file.xyz',
      };

      await expect(sut.handleAssetRefresh(mockLibraryJob)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should import a new asset', async () => {
      const mockLibraryJob: ILibraryFileJob = {
        id: libraryStub.externalLibrary1.id,
        ownerId: mockUser.id,
        assetPath: '/data/user1/photo.jpg',
        force: false,
      };

      assetMock.getByLibraryIdAndOriginalPath.mockResolvedValue(null);
      assetMock.create.mockResolvedValue(assetStub.image);

      await expect(sut.handleAssetRefresh(mockLibraryJob)).resolves.toBe(JobStatus.SUCCESS);

      expect(assetMock.create.mock.calls).toEqual([
        [
          {
            ownerId: mockUser.id,
            libraryId: libraryStub.externalLibrary1.id,
            checksum: expect.any(Buffer),
            originalPath: '/data/user1/photo.jpg',
            deviceAssetId: expect.any(String),
            deviceId: 'Library Import',
            fileCreatedAt: expect.any(Date),
            fileModifiedAt: expect.any(Date),
            localDateTime: expect.any(Date),
            type: AssetType.IMAGE,
            originalFileName: 'photo.jpg',
            sidecarPath: null,
            isExternal: true,
          },
        ],
      ]);

      expect(jobMock.queue.mock.calls).toEqual([
        [
          {
            name: JobName.METADATA_EXTRACTION,
            data: {
              id: assetStub.image.id,
            },
          },
        ],
      ]);
    });

    it('should import a new asset with sidecar', async () => {
      const mockLibraryJob: ILibraryFileJob = {
        id: libraryStub.externalLibrary1.id,
        ownerId: mockUser.id,
        assetPath: '/data/user1/photo.jpg',
        force: false,
      };

      assetMock.getByLibraryIdAndOriginalPath.mockResolvedValue(null);
      assetMock.create.mockResolvedValue(assetStub.image);
      storageMock.checkFileExists.mockResolvedValue(true);

      await expect(sut.handleAssetRefresh(mockLibraryJob)).resolves.toBe(JobStatus.SUCCESS);

      expect(assetMock.create.mock.calls).toEqual([
        [
          {
            ownerId: mockUser.id,
            libraryId: libraryStub.externalLibrary1.id,
            checksum: expect.any(Buffer),
            originalPath: '/data/user1/photo.jpg',
            deviceAssetId: expect.any(String),
            deviceId: 'Library Import',
            fileCreatedAt: expect.any(Date),
            fileModifiedAt: expect.any(Date),
            localDateTime: expect.any(Date),
            type: AssetType.IMAGE,
            originalFileName: 'photo.jpg',
            sidecarPath: '/data/user1/photo.jpg.xmp',
            isExternal: true,
          },
        ],
      ]);

      expect(jobMock.queue.mock.calls).toEqual([
        [
          {
            name: JobName.METADATA_EXTRACTION,
            data: {
              id: assetStub.image.id,
            },
          },
        ],
      ]);
    });

    it('should import a new video', async () => {
      const mockLibraryJob: ILibraryFileJob = {
        id: libraryStub.externalLibrary1.id,
        ownerId: mockUser.id,
        assetPath: '/data/user1/video.mp4',
        force: false,
      };

      assetMock.getByLibraryIdAndOriginalPath.mockResolvedValue(null);
      assetMock.create.mockResolvedValue(assetStub.video);

      await expect(sut.handleAssetRefresh(mockLibraryJob)).resolves.toBe(JobStatus.SUCCESS);

      expect(assetMock.create.mock.calls).toEqual([
        [
          {
            ownerId: mockUser.id,
            libraryId: libraryStub.externalLibrary1.id,
            checksum: expect.any(Buffer),
            originalPath: '/data/user1/video.mp4',
            deviceAssetId: expect.any(String),
            deviceId: 'Library Import',
            fileCreatedAt: expect.any(Date),
            fileModifiedAt: expect.any(Date),
            localDateTime: expect.any(Date),
            type: AssetType.VIDEO,
            originalFileName: 'video.mp4',
            sidecarPath: null,
            isExternal: true,
          },
        ],
      ]);

      expect(jobMock.queue.mock.calls).toEqual([
        [
          {
            name: JobName.METADATA_EXTRACTION,
            data: {
              id: assetStub.image.id,
            },
          },
        ],
        [
          {
            name: JobName.VIDEO_CONVERSION,
            data: {
              id: assetStub.video.id,
            },
          },
        ],
      ]);
    });

    it('should not import an asset to a soft deleted library', async () => {
      const mockLibraryJob: ILibraryFileJob = {
        id: libraryStub.externalLibrary1.id,
        ownerId: mockUser.id,
        assetPath: '/data/user1/photo.jpg',
        force: false,
      };

      assetMock.getByLibraryIdAndOriginalPath.mockResolvedValue(null);
      assetMock.create.mockResolvedValue(assetStub.image);
      libraryMock.get.mockResolvedValue({ ...libraryStub.externalLibrary1, deletedAt: new Date() });

      await expect(sut.handleAssetRefresh(mockLibraryJob)).resolves.toBe(JobStatus.FAILED);

      expect(assetMock.create.mock.calls).toEqual([]);
    });

    it('should not refresh a file whose mtime matches existing asset', async () => {
      const mockLibraryJob: ILibraryFileJob = {
        id: libraryStub.externalLibrary1.id,
        ownerId: mockUser.id,
        assetPath: assetStub.hasFileExtension.originalPath,
        force: false,
      };

      storageMock.stat.mockResolvedValue({
        size: 100,
        mtime: assetStub.hasFileExtension.fileModifiedAt,
        ctime: new Date('2023-01-01'),
      } as Stats);

      assetMock.getByLibraryIdAndOriginalPath.mockResolvedValue(assetStub.hasFileExtension);

      await expect(sut.handleAssetRefresh(mockLibraryJob)).resolves.toBe(JobStatus.SKIPPED);

      expect(jobMock.queue).not.toHaveBeenCalled();
      expect(jobMock.queueAll).not.toHaveBeenCalled();
    });

    it('should refresh a file whose mtime differs from existing asset', async () => {
      const mockLibraryJob: ILibraryFileJob = {
        id: libraryStub.externalLibrary1.id,
        ownerId: mockUser.id,
        assetPath: '/data/user1/photo.jpg',
        force: false,
      };

      assetMock.getByLibraryIdAndOriginalPath.mockResolvedValue(assetStub.image);
      assetMock.create.mockResolvedValue(assetStub.image);

      await expect(sut.handleAssetRefresh(mockLibraryJob)).resolves.toBe(JobStatus.SUCCESS);

      expect(jobMock.queue).toHaveBeenCalledWith({
        name: JobName.METADATA_EXTRACTION,
        data: {
          id: assetStub.image.id,
        },
      });

      expect(jobMock.queue).not.toHaveBeenCalledWith({
        name: JobName.VIDEO_CONVERSION,
        data: {
          id: assetStub.image.id,
        },
      });
    });

    it('should not refresh an asset trashed by user', async () => {
      const mockLibraryJob: ILibraryFileJob = {
        id: libraryStub.externalLibrary1.id,
        ownerId: mockUser.id,
        assetPath: assetStub.hasFileExtension.originalPath,
      };

      assetMock.getByLibraryIdAndOriginalPath.mockResolvedValue(assetStub.trashedByUser);

      await expect(sut.handleAssetRefresh(mockLibraryJob)).resolves.toBe(JobStatus.SKIPPED);

      expect(jobMock.queue).not.toHaveBeenCalled();
      expect(jobMock.queueAll).not.toHaveBeenCalled();
    });

    it('should un-trash an asset previously marked as offline', async () => {
      const mockLibraryJob: ILibraryFileJob = {
        id: libraryStub.externalLibrary1.id,
        ownerId: mockUser.id,
        assetPath: assetStub.hasFileExtension.originalPath,
      };

      assetMock.getByLibraryIdAndOriginalPath.mockResolvedValue(assetStub.trashedOffline);

      await expect(sut.handleAssetRefresh(mockLibraryJob)).resolves.toBe(JobStatus.SUCCESS);

      expect(assetMock.restoreAll).toHaveBeenCalledWith([assetStub.trashedOffline.id]);
    });

    it('should throw BadRequestException when asset does not exist', async () => {
      storageMock.stat.mockRejectedValue(new Error("ENOENT, no such file or directory '/data/user1/photo.jpg'"));

      const mockLibraryJob: ILibraryFileJob = {
        id: libraryStub.externalLibrary1.id,
        ownerId: userStub.admin.id,
        assetPath: '/data/user1/photo.jpg',
      };

      assetMock.getByLibraryIdAndOriginalPath.mockResolvedValue(null);
      assetMock.create.mockResolvedValue(assetStub.image);

      await expect(sut.handleAssetRefresh(mockLibraryJob)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('delete', () => {
    it('should delete a library', async () => {
      assetMock.getByLibraryIdAndOriginalPath.mockResolvedValue(assetStub.image);
      libraryMock.get.mockResolvedValue(libraryStub.externalLibrary1);

      await sut.delete(libraryStub.externalLibrary1.id);

      expect(jobMock.queue).toHaveBeenCalledWith({
        name: JobName.LIBRARY_DELETE,
        data: { id: libraryStub.externalLibrary1.id },
      });

      expect(libraryMock.softDelete).toHaveBeenCalledWith(libraryStub.externalLibrary1.id);
    });

    it('should allow an external library to be deleted', async () => {
      assetMock.getByLibraryIdAndOriginalPath.mockResolvedValue(assetStub.image);
      libraryMock.get.mockResolvedValue(libraryStub.externalLibrary1);

      await sut.delete(libraryStub.externalLibrary1.id);

      expect(jobMock.queue).toHaveBeenCalledWith({
        name: JobName.LIBRARY_DELETE,
        data: { id: libraryStub.externalLibrary1.id },
      });

      expect(libraryMock.softDelete).toHaveBeenCalledWith(libraryStub.externalLibrary1.id);
    });

    it('should unwatch an external library when deleted', async () => {
      assetMock.getByLibraryIdAndOriginalPath.mockResolvedValue(assetStub.image);
      libraryMock.get.mockResolvedValue(libraryStub.externalLibraryWithImportPaths1);
      libraryMock.getAll.mockResolvedValue([libraryStub.externalLibraryWithImportPaths1]);

      systemMock.get.mockResolvedValue(systemConfigStub.libraryWatchEnabled);

      const mockClose = vitest.fn();
      storageMock.watch.mockImplementation(makeMockWatcher({ close: mockClose }));

      await sut.onBootstrap();
      await sut.delete(libraryStub.externalLibraryWithImportPaths1.id);

      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('should return a library', async () => {
      libraryMock.get.mockResolvedValue(libraryStub.externalLibrary1);
      await expect(sut.get(libraryStub.externalLibrary1.id)).resolves.toEqual(
        expect.objectContaining({
          id: libraryStub.externalLibrary1.id,
          name: libraryStub.externalLibrary1.name,
          ownerId: libraryStub.externalLibrary1.ownerId,
        }),
      );

      expect(libraryMock.get).toHaveBeenCalledWith(libraryStub.externalLibrary1.id);
    });

    it('should throw an error when a library is not found', async () => {
      libraryMock.get.mockResolvedValue(null);
      await expect(sut.get(libraryStub.externalLibrary1.id)).rejects.toBeInstanceOf(BadRequestException);
      expect(libraryMock.get).toHaveBeenCalledWith(libraryStub.externalLibrary1.id);
    });
  });

  describe('getStatistics', () => {
    it('should return library statistics', async () => {
      libraryMock.get.mockResolvedValue(libraryStub.externalLibrary1);
      libraryMock.getStatistics.mockResolvedValue({ photos: 10, videos: 0, total: 10, usage: 1337 });
      await expect(sut.getStatistics(libraryStub.externalLibrary1.id)).resolves.toEqual({
        photos: 10,
        videos: 0,
        total: 10,
        usage: 1337,
      });

      expect(libraryMock.getStatistics).toHaveBeenCalledWith(libraryStub.externalLibrary1.id);
    });
  });

  describe('create', () => {
    describe('external library', () => {
      it('should create with default settings', async () => {
        libraryMock.create.mockResolvedValue(libraryStub.externalLibrary1);
        await expect(sut.create({ ownerId: authStub.admin.user.id })).resolves.toEqual(
          expect.objectContaining({
            id: libraryStub.externalLibrary1.id,
            name: libraryStub.externalLibrary1.name,
            ownerId: libraryStub.externalLibrary1.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: libraryStub.externalLibrary1.createdAt,
            updatedAt: libraryStub.externalLibrary1.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(libraryMock.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: expect.any(String),
            importPaths: [],
            exclusionPatterns: [],
          }),
        );
      });

      it('should create with name', async () => {
        libraryMock.create.mockResolvedValue(libraryStub.externalLibrary1);
        await expect(sut.create({ ownerId: authStub.admin.user.id, name: 'My Awesome Library' })).resolves.toEqual(
          expect.objectContaining({
            id: libraryStub.externalLibrary1.id,
            name: libraryStub.externalLibrary1.name,
            ownerId: libraryStub.externalLibrary1.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: libraryStub.externalLibrary1.createdAt,
            updatedAt: libraryStub.externalLibrary1.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(libraryMock.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'My Awesome Library',
            importPaths: [],
            exclusionPatterns: [],
          }),
        );
      });

      it('should create with import paths', async () => {
        libraryMock.create.mockResolvedValue(libraryStub.externalLibrary1);
        await expect(
          sut.create({
            ownerId: authStub.admin.user.id,
            importPaths: ['/data/images', '/data/videos'],
          }),
        ).resolves.toEqual(
          expect.objectContaining({
            id: libraryStub.externalLibrary1.id,
            name: libraryStub.externalLibrary1.name,
            ownerId: libraryStub.externalLibrary1.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: libraryStub.externalLibrary1.createdAt,
            updatedAt: libraryStub.externalLibrary1.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(libraryMock.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: expect.any(String),
            importPaths: ['/data/images', '/data/videos'],
            exclusionPatterns: [],
          }),
        );
      });

      it('should create watched with import paths', async () => {
        systemMock.get.mockResolvedValue(systemConfigStub.libraryWatchEnabled);
        libraryMock.create.mockResolvedValue(libraryStub.externalLibraryWithImportPaths1);
        libraryMock.get.mockResolvedValue(libraryStub.externalLibraryWithImportPaths1);
        libraryMock.getAll.mockResolvedValue([]);

        await sut.onBootstrap();
        await sut.create({
          ownerId: authStub.admin.user.id,
          importPaths: libraryStub.externalLibraryWithImportPaths1.importPaths,
        });
      });

      it('should create with exclusion patterns', async () => {
        libraryMock.create.mockResolvedValue(libraryStub.externalLibrary1);
        await expect(
          sut.create({
            ownerId: authStub.admin.user.id,
            exclusionPatterns: ['*.tmp', '*.bak'],
          }),
        ).resolves.toEqual(
          expect.objectContaining({
            id: libraryStub.externalLibrary1.id,
            name: libraryStub.externalLibrary1.name,
            ownerId: libraryStub.externalLibrary1.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: libraryStub.externalLibrary1.createdAt,
            updatedAt: libraryStub.externalLibrary1.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(libraryMock.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: expect.any(String),
            importPaths: [],
            exclusionPatterns: ['*.tmp', '*.bak'],
          }),
        );
      });
    });
  });

  describe('handleQueueCleanup', () => {
    it('should queue cleanup jobs', async () => {
      libraryMock.getAllDeleted.mockResolvedValue([libraryStub.externalLibrary1, libraryStub.externalLibrary2]);
      await expect(sut.handleQueueCleanup()).resolves.toBe(JobStatus.SUCCESS);

      expect(jobMock.queueAll).toHaveBeenCalledWith([
        { name: JobName.LIBRARY_DELETE, data: { id: libraryStub.externalLibrary1.id } },
        { name: JobName.LIBRARY_DELETE, data: { id: libraryStub.externalLibrary2.id } },
      ]);
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      systemMock.get.mockResolvedValue(systemConfigStub.libraryWatchEnabled);
      libraryMock.getAll.mockResolvedValue([]);

      await sut.onBootstrap();
    });

    it('should update library', async () => {
      libraryMock.update.mockResolvedValue(libraryStub.externalLibrary1);
      libraryMock.get.mockResolvedValue(libraryStub.externalLibrary1);
      await expect(sut.update('library-id', {})).resolves.toEqual(mapLibrary(libraryStub.externalLibrary1));
      expect(libraryMock.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'library-id' }));
    });
  });

  describe('watchAll', () => {
    describe('watching disabled', () => {
      beforeEach(async () => {
        systemMock.get.mockResolvedValue(systemConfigStub.libraryWatchDisabled);

        await sut.onBootstrap();
      });

      it('should not watch library', async () => {
        libraryMock.getAll.mockResolvedValue([libraryStub.externalLibraryWithImportPaths1]);

        await sut.watchAll();

        expect(storageMock.watch).not.toHaveBeenCalled();
      });
    });

    describe('watching enabled', () => {
      beforeEach(async () => {
        systemMock.get.mockResolvedValue(systemConfigStub.libraryWatchEnabled);
        libraryMock.getAll.mockResolvedValue([]);
        await sut.onBootstrap();
      });

      it('should watch library', async () => {
        libraryMock.get.mockResolvedValue(libraryStub.externalLibraryWithImportPaths1);
        libraryMock.getAll.mockResolvedValue([libraryStub.externalLibraryWithImportPaths1]);

        await sut.watchAll();

        expect(storageMock.watch).toHaveBeenCalledWith(
          libraryStub.externalLibraryWithImportPaths1.importPaths,
          expect.anything(),
          expect.anything(),
        );
      });

      it('should watch and unwatch library', async () => {
        libraryMock.getAll.mockResolvedValue([libraryStub.externalLibraryWithImportPaths1]);
        libraryMock.get.mockResolvedValue(libraryStub.externalLibraryWithImportPaths1);
        const mockClose = vitest.fn();
        storageMock.watch.mockImplementation(makeMockWatcher({ close: mockClose }));

        await sut.watchAll();
        await sut.unwatch(libraryStub.externalLibraryWithImportPaths1.id);

        expect(mockClose).toHaveBeenCalled();
      });

      it('should not watch library without import paths', async () => {
        libraryMock.get.mockResolvedValue(libraryStub.externalLibrary1);
        libraryMock.getAll.mockResolvedValue([libraryStub.externalLibrary1]);

        await sut.watchAll();

        expect(storageMock.watch).not.toHaveBeenCalled();
      });

      it('should handle a new file event', async () => {
        libraryMock.get.mockResolvedValue(libraryStub.externalLibraryWithImportPaths1);
        libraryMock.getAll.mockResolvedValue([libraryStub.externalLibraryWithImportPaths1]);
        storageMock.watch.mockImplementation(makeMockWatcher({ items: [{ event: 'add', value: '/foo/photo.jpg' }] }));

        await sut.watchAll();

        expect(jobMock.queueAll).toHaveBeenCalledWith([
          {
            name: JobName.LIBRARY_SCAN_ASSET,
            data: {
              id: libraryStub.externalLibraryWithImportPaths1.id,
              assetPath: '/foo/photo.jpg',
              ownerId: libraryStub.externalLibraryWithImportPaths1.owner.id,
            },
          },
        ]);
      });

      it('should handle a file change event', async () => {
        libraryMock.get.mockResolvedValue(libraryStub.externalLibraryWithImportPaths1);
        libraryMock.getAll.mockResolvedValue([libraryStub.externalLibraryWithImportPaths1]);
        storageMock.watch.mockImplementation(
          makeMockWatcher({ items: [{ event: 'change', value: '/foo/photo.jpg' }] }),
        );

        await sut.watchAll();

        expect(jobMock.queueAll).toHaveBeenCalledWith([
          {
            name: JobName.LIBRARY_SCAN_ASSET,
            data: {
              id: libraryStub.externalLibraryWithImportPaths1.id,
              assetPath: '/foo/photo.jpg',
              ownerId: libraryStub.externalLibraryWithImportPaths1.owner.id,
            },
          },
        ]);
      });

      it('should handle an error event', async () => {
        libraryMock.get.mockResolvedValue(libraryStub.externalLibraryWithImportPaths1);
        assetMock.getByLibraryIdAndOriginalPath.mockResolvedValue(assetStub.external);
        libraryMock.getAll.mockResolvedValue([libraryStub.externalLibraryWithImportPaths1]);
        storageMock.watch.mockImplementation(
          makeMockWatcher({
            items: [{ event: 'error', value: 'Error!' }],
          }),
        );

        await expect(sut.watchAll()).resolves.toBeUndefined();
      });

      it('should ignore unknown extensions', async () => {
        libraryMock.get.mockResolvedValue(libraryStub.externalLibraryWithImportPaths1);
        libraryMock.getAll.mockResolvedValue([libraryStub.externalLibraryWithImportPaths1]);
        storageMock.watch.mockImplementation(makeMockWatcher({ items: [{ event: 'add', value: '/foo/photo.jpg' }] }));

        await sut.watchAll();

        expect(jobMock.queue).not.toHaveBeenCalled();
      });

      it('should ignore excluded paths', async () => {
        libraryMock.get.mockResolvedValue(libraryStub.patternPath);
        libraryMock.getAll.mockResolvedValue([libraryStub.patternPath]);
        storageMock.watch.mockImplementation(makeMockWatcher({ items: [{ event: 'add', value: '/dir1/photo.txt' }] }));

        await sut.watchAll();

        expect(jobMock.queue).not.toHaveBeenCalled();
      });

      it('should ignore excluded paths without case sensitivity', async () => {
        libraryMock.get.mockResolvedValue(libraryStub.patternPath);
        libraryMock.getAll.mockResolvedValue([libraryStub.patternPath]);
        storageMock.watch.mockImplementation(makeMockWatcher({ items: [{ event: 'add', value: '/DIR1/photo.txt' }] }));

        await sut.watchAll();

        expect(jobMock.queue).not.toHaveBeenCalled();
      });
    });
  });

  describe('teardown', () => {
    it('should tear down all watchers', async () => {
      libraryMock.getAll.mockResolvedValue([
        libraryStub.externalLibraryWithImportPaths1,
        libraryStub.externalLibraryWithImportPaths2,
      ]);

      systemMock.get.mockResolvedValue(systemConfigStub.libraryWatchEnabled);
      libraryMock.get.mockResolvedValue(libraryStub.externalLibrary1);

      libraryMock.get.mockImplementation((id) =>
        Promise.resolve(
          [libraryStub.externalLibraryWithImportPaths1, libraryStub.externalLibraryWithImportPaths2].find(
            (library) => library.id === id,
          ) || null,
        ),
      );

      const mockClose = vitest.fn();
      storageMock.watch.mockImplementation(makeMockWatcher({ close: mockClose }));

      await sut.onBootstrap();
      await sut.onShutdown();

      expect(mockClose).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleDeleteLibrary', () => {
    it('should delete an empty library', async () => {
      libraryMock.get.mockResolvedValue(libraryStub.externalLibrary1);
      assetMock.getAll.mockResolvedValue({ items: [], hasNextPage: false });
      libraryMock.delete.mockImplementation(async () => {});

      await expect(sut.handleDeleteLibrary({ id: libraryStub.externalLibrary1.id })).resolves.toBe(JobStatus.SUCCESS);
    });

    it('should delete a library with assets', async () => {
      libraryMock.get.mockResolvedValue(libraryStub.externalLibrary1);
      assetMock.getAll.mockResolvedValue({ items: [assetStub.image1], hasNextPage: false });
      libraryMock.delete.mockImplementation(async () => {});

      assetMock.getById.mockResolvedValue(assetStub.image1);

      await expect(sut.handleDeleteLibrary({ id: libraryStub.externalLibrary1.id })).resolves.toBe(JobStatus.SUCCESS);
    });
  });

  describe('queueScan', () => {
    it('should queue a library scan', async () => {
      libraryMock.get.mockResolvedValue(libraryStub.externalLibrary1);

      await sut.queueScan(libraryStub.externalLibrary1.id);

      expect(jobMock.queue.mock.calls).toEqual([
        [
          {
            name: JobName.LIBRARY_QUEUE_SCAN,
            data: {
              id: libraryStub.externalLibrary1.id,
            },
          },
        ],
        [
          {
            name: JobName.LIBRARY_QUEUE_REMOVE_DELETED,
            data: {
              id: libraryStub.externalLibrary1.id,
            },
          },
        ],
      ]);
    });
  });

  describe('queueOfflineCheck', () => {
    it('should queue the trash job', async () => {
      await sut.queueOfflineCheck(libraryStub.externalLibrary1.id);

      expect(jobMock.queue.mock.calls).toEqual([
        [
          {
            name: JobName.LIBRARY_OFFLINE_CHECK,
            data: {
              id: libraryStub.externalLibrary1.id,
            },
          },
        ],
      ]);
    });
  });

  describe('handleQueueAllScan', () => {
    it('should queue the refresh job', async () => {
      libraryMock.getAll.mockResolvedValue([libraryStub.externalLibrary1]);

      await expect(sut.handleQueueAllScan()).resolves.toBe(JobStatus.SUCCESS);

      expect(jobMock.queue.mock.calls).toEqual([
        [
          {
            name: JobName.LIBRARY_QUEUE_CLEANUP,
            data: {},
          },
        ],
      ]);
      expect(jobMock.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.LIBRARY_QUEUE_SCAN,
          data: {
            id: libraryStub.externalLibrary1.id,
          },
        },
      ]);
    });
  });

  describe('handleQueueAssetOfflineCheck', () => {
    it('should queue removal jobs', async () => {
      libraryMock.get.mockResolvedValue(libraryStub.externalLibrary1);
      assetMock.getAll.mockResolvedValue({ items: [assetStub.image1], hasNextPage: false });
      assetMock.getById.mockResolvedValue(assetStub.image1);

      await expect(sut.handleQueueAssetOfflineCheck({ id: libraryStub.externalLibrary1.id })).resolves.toBe(
        JobStatus.SUCCESS,
      );

      expect(jobMock.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.LIBRARY_OFFLINE_CHECK,
          data: {
            id: assetStub.image1.id,
            importPaths: libraryStub.externalLibrary1.importPaths,
            exclusionPatterns: libraryStub.externalLibrary1.exclusionPatterns,
          },
        },
      ]);
    });
  });

  describe('validate', () => {
    it('should validate directory', async () => {
      storageMock.stat.mockResolvedValue({
        isDirectory: () => true,
      } as Stats);

      storageMock.checkFileExists.mockResolvedValue(true);

      await expect(sut.validate('library-id', { importPaths: ['/data/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/data/user1/',
            isValid: true,
            message: undefined,
          },
        ],
      });
    });

    it('should detect when path does not exist', async () => {
      storageMock.stat.mockImplementation(() => {
        const error = { code: 'ENOENT' } as any;
        throw error;
      });

      await expect(sut.validate('library-id', { importPaths: ['/data/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/data/user1/',
            isValid: false,
            message: 'Path does not exist (ENOENT)',
          },
        ],
      });
    });

    it('should detect when path is not a directory', async () => {
      storageMock.stat.mockResolvedValue({
        isDirectory: () => false,
      } as Stats);

      await expect(sut.validate('library-id', { importPaths: ['/data/user1/file'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/data/user1/file',
            isValid: false,
            message: 'Not a directory',
          },
        ],
      });
    });

    it('should return an unknown exception from stat', async () => {
      storageMock.stat.mockImplementation(() => {
        throw new Error('Unknown error');
      });

      await expect(sut.validate('library-id', { importPaths: ['/data/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/data/user1/',
            isValid: false,
            message: 'Error: Unknown error',
          },
        ],
      });
    });

    it('should detect when access rights are missing', async () => {
      storageMock.stat.mockResolvedValue({
        isDirectory: () => true,
      } as Stats);

      storageMock.checkFileExists.mockResolvedValue(false);

      await expect(sut.validate('library-id', { importPaths: ['/data/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/data/user1/',
            isValid: false,
            message: 'Lacking read permission for folder',
          },
        ],
      });
    });

    it('should detect when import path is in immich media folder', async () => {
      storageMock.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
      const validImport = libraryStub.hasImmichPaths.importPaths[1];
      storageMock.checkFileExists.mockImplementation((importPath) => Promise.resolve(importPath === validImport));

      await expect(
        sut.validate('library-id', { importPaths: libraryStub.hasImmichPaths.importPaths }),
      ).resolves.toEqual({
        importPaths: [
          {
            importPath: libraryStub.hasImmichPaths.importPaths[0],
            isValid: false,
            message: 'Cannot use media upload folder for external libraries',
          },
          {
            importPath: validImport,
            isValid: true,
          },
          {
            importPath: libraryStub.hasImmichPaths.importPaths[2],
            isValid: false,
            message: 'Cannot use media upload folder for external libraries',
          },
        ],
      });
    });
  });
});
