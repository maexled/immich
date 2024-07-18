import { BinaryField, Tags } from 'exiftool-vendored';

export const IMetadataRepository = 'IMetadataRepository';

export interface ExifDuration {
  Value: number;
  Scale?: number;
}

export interface ImmichTagsBase extends Omit<Tags, 'FocalLength' | 'Duration'> {
  ContentIdentifier?: string;
  MotionPhoto?: number;
  MotionPhotoVersion?: number;
  MotionPhotoPresentationTimestampUs?: number;
  MediaGroupUUID?: string;
  ImagePixelDepth?: string;
  FocalLength?: number;
  Duration?: number | string | ExifDuration;
  EmbeddedVideoType?: string;
  EmbeddedVideoFile?: BinaryField;
  MotionPhotoVideo?: BinaryField;
}

// Extends properties not defined by exiftools tag
export interface ImmichTags extends Omit<ImmichTagsBase, 'RegionInfo'> {
  /** ☆☆☆☆ ✔ Example: {"AppliedToDimensions":{"H":3552,"W":2000},"RegionList":[…ace"}]} */
  RegionInfo?: {
    /** ☆☆☆☆ ✔ Example: {"H": 640, "Unit": "pixel", "W": 800} */
    AppliedToDimensions: {
      W: number;
      H: number;
      Unit: string;
    };
    /** ☆☆☆☆ ✔ Example: [{"Area":{},"Name":"John Doe","Type":"Face"}] */
    RegionList: {
      Area: {
        // (X,Y) // center of the rectancle
        // W & H: rectangle width and height
        X: number;
        Y: number;
        W: number;
        H: number;
        Unit: string;
      };
      Rotation?: number;
      Type?: string;
      Name?: string;
    }[];
  };
}

export interface IMetadataRepository {
  teardown(): Promise<void>;
  readTags(path: string): Promise<ImmichTags | null>;
  writeTags(path: string, tags: Partial<Tags>): Promise<void>;
  extractBinaryTag(tagName: string, path: string): Promise<Buffer>;
  getCountries(userId: string): Promise<string[]>;
  getStates(userId: string, country?: string): Promise<string[]>;
  getCities(userId: string, country?: string, state?: string): Promise<string[]>;
  getCameraMakes(userId: string, model?: string): Promise<string[]>;
  getCameraModels(userId: string, make?: string): Promise<string[]>;
}
