
export type FaceName = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';

export interface TileData {
  level: number;
  face: FaceName;
  row: number;
  col: number;
  dataUrl: string;
}

export interface ProcessedData {
  level1: TileData[];
  level2: TileData[];
  level3: TileData[];
}

export type ProcessStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'ERROR';

export interface ImageItem {
  id: string;
  name: string;
  file: File;
  status: ProcessStatus;
  progress: number;
  result?: ProcessedData;
  error?: string;
}
