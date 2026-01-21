
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

export interface MarkerTarget {
  imageId: string;
  fov: number;
  rotation: { x: number; y: number; z: number };
}

export interface Marker {
  id: string;
  type: 'HOTSPOT' | 'TEXT';
  position: { x: number; y: number; z: number };
  content?: string;
  target?: MarkerTarget;
  color?: string;
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
  markers: Marker[];
}
