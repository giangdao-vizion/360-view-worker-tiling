
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Camera, Image as ImageIcon, Loader2, ZoomIn, Move, AlertCircle, CheckCircle2, Plus, Clock, ChevronRight, Download, PanelLeftClose, PanelLeft, MapPin, Type, Save, Trash2, Crosshair, X } from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { ImageItem, TileData, Marker } from './types';

declare const JSZip: any;

const workerCode = `
  const FACES = {
    px: { origin: [ 1,  1,  1], ux: [ 0,  0, -2], uy: [ 0, -2,  0] },
    nx: { origin: [-1,  1, -1], ux: [ 0,  0,  2], uy: [ 0, -2,  0] },
    py: { origin: [-1,  1, -1], ux: [ 2,  0,  0], uy: [ 0,  0,  2] },
    ny: { origin: [-1, -1,  1], ux: [ 2,  0,  0], uy: [ 0,  0, -2] },
    pz: { origin: [-1,  1,  1], ux: [ 2,  0,  0], uy: [ 0, -2,  0] },
    nz: { origin: [ 1,  1, -1], ux: [-2,  0,  0], uy: [ 0, -2,  0] },
  };

  self.onmessage = async (e) => {
    const { imageBitmap, tileRes = 512 } = e.data;
    const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imageBitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data, width, height } = imageData;
    
    const levels = [{ id: 1, res: 512, tiles: 1 }, { id: 2, res: 1024, tiles: 2 }, { id: 3, res: 2048, tiles: 4 }];
    const results = { level1: [], level2: [], level3: [] };
    let completed = 0;
    const total = 126; 
    
    const getPixelBilinear = (u, v) => {
      let u_wrapped = u % 1;
      if (u_wrapped < 0) u_wrapped += 1;
      const x = u_wrapped * (width - 1);
      const y = Math.max(0, Math.min(1, v)) * (height - 1);
      const x1 = Math.floor(x); const y1 = Math.floor(y);
      const x2 = (x1 + 1) % width; const y2 = Math.min(height - 1, y1 + 1);
      const dx = x - x1; const dy = y - y1;
      const getP = (px, py) => { const i = (py * width + px) * 4; return [data[i], data[i+1], data[i+2], data[i+3]]; };
      const p11 = getP(x1, y1); const p21 = getP(x2, y1); const p12 = getP(x1, y2); const p22 = getP(x2, y2);
      const blend = (c1, c2, c3, c4) => c1 * (1 - dx) * (1 - dy) + c2 * dx * (1 - dy) + c3 * (1 - dx) * dy + c4 * dx * dy;
      return [blend(p11[0], p21[0], p12[0], p22[0]), blend(p11[1], p21[1], p12[1], p22[1]), blend(p11[2], p21[2], p12[2], p22[2]), blend(p11[3], p21[3], p12[3], p22[3])];
    };

    for (const level of levels) {
      for (const face of Object.keys(FACES)) {
        const config = FACES[face];
        for (let r = 0; r < level.tiles; r++) {
          for (let c = 0; c < level.tiles; c++) {
            const tCanvas = new OffscreenCanvas(tileRes, tileRes);
            const tCtx = tCanvas.getContext('2d');
            const tData = tCtx.createImageData(tileRes, tileRes);
            const tPix = tData.data;
            
            for (let ty = 0; ty < tileRes; ty++) {
              for (let tx = 0; tx < tileRes; tx++) {
                const fx = (c * tileRes + tx) / level.res; const fy = (r * tileRes + ty) / level.res;
                const p = [
                  config.origin[0] + fx * config.ux[0] + fy * config.uy[0],
                  config.origin[1] + fx * config.ux[1] + fy * config.uy[1],
                  config.origin[2] + fx * config.ux[2] + fy * config.uy[2]
                ];
                const dist = Math.sqrt(p[0]*p[0] + p[1]*p[1] + p[2]*p[2]);
                const lon = Math.atan2(p[2], p[0]);
                const lat = Math.acos(p[1] / dist);
                const u = (lon + Math.PI) / (2 * Math.PI);
                const v = lat / Math.PI;
                const pix = getPixelBilinear(u, v);
                const idx = (ty * tileRes + tx) * 4;
                tPix[idx] = pix[0]; tPix[idx+1] = pix[1]; tPix[idx+2] = pix[2]; tPix[idx+3] = pix[3];
              }
            }
            tCtx.putImageData(tData, 0, 0);
            const blob = await tCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
            const dataUrl = await new Promise(res => {
              const reader = new FileReader();
              reader.onloadend = () => res(reader.result);
              reader.readAsDataURL(blob);
            });
            results['level' + level.id].push({ level: level.id, face, row: r, col: c, dataUrl });
            completed++;
            self.postMessage({ type: 'PROGRESS', progress: Math.round((completed/total)*100) });
          }
        }
      }
    }
    self.postMessage({ type: 'COMPLETE', data: results });
  };
`;

const TargetViewPicker: React.FC<{
  image: ImageItem;
  initialFov?: number;
  initialRotation?: { x: number; y: number; z: number };
  onConfirm: (fov: number, rotation: { x: number; y: number; z: number }) => void;
  onClose: () => void;
}> = ({ image, initialFov, initialRotation, onConfirm, onClose }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalRef = useRef<{
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
  } | null>(null);

  useEffect(() => {
    if (!containerRef.current || !image.result) return;
    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(initialFov || 60, width / height, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    containerRef.current.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableZoom = true;
    controls.rotateSpeed = -0.4;
    controls.enableDamping = true;
    
    if (initialRotation) {
      camera.rotation.set(initialRotation.x, initialRotation.y, initialRotation.z);
    } else {
      camera.position.set(0, 0, 0.1);
    }
    controls.update();

    const facesGroup = new THREE.Group();
    scene.add(facesGroup);

    const loader = new THREE.TextureLoader();
    const dist = 50;
    // Fix: Using explicit tuple types to prevent spread argument errors on lines 152 and 153
    const faceConfigs: Record<string, { pos: [number, number, number], rot: [number, number, number] }> = {
      px: { pos: [dist, 0, 0], rot: [0, -Math.PI / 2, 0] }, 
      nx: { pos: [-dist, 0, 0], rot: [0, Math.PI / 2, 0] },
      py: { pos: [0, dist, 0], rot: [Math.PI / 2, 0, Math.PI] }, 
      ny: { pos: [0, -dist, 0], rot: [-Math.PI / 2, 0, Math.PI] },
      pz: { pos: [0, 0, dist], rot: [0, Math.PI, 0] }, 
      nz: { pos: [0, 0, -dist], rot: [0, 0, 0] }
    };

    image.result.level1.forEach(tile => {
      loader.load(tile.dataUrl, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
        const geo = new THREE.PlaneGeometry(dist * 2, dist * 2);
        geo.scale(-1, 1, 1);
        const mesh = new THREE.Mesh(geo, mat);
        const cfg = faceConfigs[tile.face];
        // Fix: cfg.pos and cfg.rot are now recognized as tuples [number, number, number]
        mesh.position.set(...cfg.pos);
        mesh.rotation.set(...cfg.rot);
        facesGroup.add(mesh);
      });
    });

    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    internalRef.current = { renderer, camera, controls };

    return () => {
      cancelAnimationFrame(animationId);
      renderer.dispose();
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  }, [image]);

  const handleConfirm = () => {
    if (!internalRef.current) return;
    const { camera } = internalRef.current;
    onConfirm(camera.fov, { x: camera.rotation.x, y: camera.rotation.y, z: camera.rotation.z });
  };

  return (
    <div className="fixed inset-0 z-[100] bg-slate-950/90 backdrop-blur-xl flex items-center justify-center p-8">
      <div className="bg-slate-900 border border-white/10 w-full max-w-5xl rounded-[2.5rem] overflow-hidden flex flex-col shadow-2xl animate-in zoom-in-95 duration-300">
        <div className="p-6 border-b border-white/5 flex items-center justify-between">
          <div>
            <h3 className="text-xl font-black text-white">Position Target View</h3>
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wider mt-1">Rotate & Zoom to set landing angle</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-full transition-colors">
            <X className="w-6 h-6 text-slate-400" />
          </button>
        </div>
        <div ref={containerRef} className="flex-1 min-h-[500px] bg-black cursor-move" />
        <div className="p-6 border-t border-white/5 flex justify-end gap-3">
          <button onClick={onClose} className="px-6 py-3 rounded-2xl text-xs font-black uppercase text-slate-400 hover:bg-white/5 transition-colors">Cancel</button>
          <button onClick={handleConfirm} className="px-8 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-xl flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" /> Confirm Target View
          </button>
        </div>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const [images, setImages] = useState<ImageItem[]>([]);
  const [activeImageId, setActiveImageId] = useState<string | null>(null);
  const [isProcessingId, setIsProcessingId] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState(60);
  const [activeLOD, setActiveLOD] = useState<number>(2);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Editing states
  const [editMode, setEditMode] = useState<'NONE' | 'HOTSPOT' | 'TEXT'>('NONE');
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [isPickingTargetView, setIsPickingTargetView] = useState(false);

  // Refs to avoid stale closures in event listeners
  const editModeRef = useRef(editMode);
  const activeImageIdRef = useRef(activeImageId);
  const imagesRef = useRef(images);

  useEffect(() => { editModeRef.current = editMode; }, [editMode]);
  useEffect(() => { activeImageIdRef.current = activeImageId; }, [activeImageId]);
  useEffect(() => { imagesRef.current = images; }, [images]);

  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    facesGroup: THREE.Group;
    pendingGroup: THREE.Group;
    markersGroup: THREE.Group;
    currentImageId: string | null;
  } | null>(null);

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const newItems: ImageItem[] = Array.from(files).map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      name: file.name,
      file,
      status: 'PENDING',
      progress: 0,
      markers: []
    }));
    setImages(prev => [...prev, ...newItems]);
  };

  useEffect(() => {
    const nextPending = images.find(img => img.status === 'PENDING');
    if (nextPending && !isProcessingId) {
      processImage(nextPending);
    }
  }, [images, isProcessingId]);

  const processImage = async (item: ImageItem) => {
    setIsProcessingId(item.id);
    setImages(prev => prev.map(img => img.id === item.id ? { ...img, status: 'PROCESSING', progress: 0 } : img));

    try {
      const bitmap = await createImageBitmap(item.file);
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));

      worker.onmessage = (event) => {
        const { type, progress, data } = event.data;
        if (type === 'PROGRESS') {
          setImages(prev => prev.map(img => img.id === item.id ? { ...img, progress } : img));
        } else if (type === 'COMPLETE') {
          setImages(prev => prev.map(img => 
            img.id === item.id ? { ...img, status: 'COMPLETED', progress: 100, result: data } : img
          ));
          if (!activeImageId) setActiveImageId(item.id);
          setIsProcessingId(null);
          worker.terminate();
        }
      };
      worker.postMessage({ imageBitmap: bitmap }, [bitmap]);
    } catch (err) {
      setImages(prev => prev.map(img => img.id === item.id ? { ...img, status: 'ERROR', error: 'Worker error' } : img));
      setIsProcessingId(null);
    }
  };

  const activeImage = images.find(img => img.id === activeImageId);

  const renderMarkers = useCallback(() => {
    if (!sceneRef.current || !activeImage) return;
    const { markersGroup } = sceneRef.current;
    markersGroup.clear();

    activeImage.markers.forEach((m) => {
      if (m.type === 'HOTSPOT') {
        const group = new THREE.Group();
        group.position.set(m.position.x, m.position.y, m.position.z);
        group.lookAt(0, 0, 0);
        group.userData = { markerId: m.id };

        // Inner solid white circle
        const innerGeo = new THREE.CircleGeometry(0.7, 32);
        const innerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
        const innerMesh = new THREE.Mesh(innerGeo, innerMat);
        
        // Outer pulsing semi-transparent white circle
        const outerGeo = new THREE.CircleGeometry(1.5, 32);
        const outerMat = new THREE.MeshBasicMaterial({ 
          color: 0xffffff, 
          transparent: true, 
          opacity: 0.5, 
          side: THREE.DoubleSide 
        });
        const outerMesh = new THREE.Mesh(outerGeo, outerMat);
        outerMesh.position.z = -0.01; // Tiny offset to prevent z-fighting

        group.add(innerMesh);
        group.add(outerMesh);
        
        // Pulse animation
        group.onBeforeRender = () => {
          const time = performance.now() * 0.003;
          const pulseScale = 1 + Math.sin(time * 1.5) * 0.2;
          const outerPulseScale = 1 + Math.sin(time * 1.5) * 0.4;
          innerMesh.scale.set(pulseScale, pulseScale, 1);
          outerMesh.scale.set(outerPulseScale, outerPulseScale, 1);
          outerMat.opacity = 0.3 + Math.sin(time * 1.5) * 0.2;
        };
        
        markersGroup.add(group);
      } else {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (ctx) {
          canvas.width = 256;
          canvas.height = 128;
          ctx.font = 'bold 32px sans-serif';
          ctx.fillStyle = 'white';
          ctx.textAlign = 'center';
          ctx.shadowColor = 'rgba(0,0,0,0.5)';
          ctx.shadowBlur = 4;
          ctx.fillText(m.content || 'Text', 128, 64);
          
          const texture = new THREE.CanvasTexture(canvas);
          const material = new THREE.SpriteMaterial({ map: texture });
          const sprite = new THREE.Sprite(material);
          sprite.position.set(m.position.x, m.position.y, m.position.z);
          sprite.scale.set(8, 4, 1);
          sprite.userData = { markerId: m.id };
          markersGroup.add(sprite);
        }
      }
    });
  }, [activeImage]);

  const createCubeInScene = useCallback((levelData: TileData[], isFastInitial = false) => {
    if (!sceneRef.current) return;
    const { pendingGroup, facesGroup, camera } = sceneRef.current;
    const loader = new THREE.TextureLoader();
    const dist = 50;

    const faceConfigs: Record<string, { pos: [number, number, number], rot: [number, number, number], normal: THREE.Vector3 }> = {
      px: { pos: [ dist,  0,  0], rot: [0, -Math.PI / 2, 0], normal: new THREE.Vector3(1, 0, 0) },
      nx: { pos: [-dist,  0,  0], rot: [0,  Math.PI / 2, 0], normal: new THREE.Vector3(-1, 0, 0) },
      py: { pos: [ 0,  dist,  0], rot: [ Math.PI / 2, 0, Math.PI], normal: new THREE.Vector3(0, 1, 0) },
      ny: { pos: [ 0, -dist,  0], rot: [-Math.PI / 2, 0, Math.PI], normal: new THREE.Vector3(0, -1, 0) },
      pz: { pos: [ 0,  0,  dist], rot: [0,  Math.PI, 0], normal: new THREE.Vector3(0, 0, 1) },
      nz: { pos: [ 0,  0, -dist], rot: [0,  0, 0], normal: new THREE.Vector3(0, 0, -1) },
    };

    pendingGroup.clear();
    const faceGroups: Record<string, THREE.Group> = {};
    Object.entries(faceConfigs).forEach(([name, cfg]) => {
      const group = new THREE.Group();
      group.position.set(...cfg.pos);
      group.rotation.set(...cfg.rot);
      group.name = name;
      pendingGroup.add(group);
      faceGroups[name] = group;
    });

    const tilesPerSide = Math.sqrt(levelData.length / 6);
    const tileSize = (dist * 2) / tilesPerSide;

    camera.updateMatrixWorld();
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);

    const inViewTiles = isFastInitial ? levelData : levelData.filter(t => camDir.dot(faceConfigs[t.face].normal) > -0.3);
    const outViewTiles = isFastInitial ? [] : levelData.filter(t => camDir.dot(faceConfigs[t.face].normal) <= -0.3);

    let loadedCount = 0;
    const finalizeSwap = () => {
      facesGroup.clear();
      while(pendingGroup.children.length > 0) facesGroup.add(pendingGroup.children[0]);
      setActiveLOD(levelData[0].level);
      if (!isFastInitial) {
        outViewTiles.forEach(tile => loadTile(tile, facesGroup));
      }
    };

    const loadTile = (tile: TileData, targetGroup: THREE.Group) => {
      loader.load(tile.dataUrl, (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
        const geo = new THREE.PlaneGeometry(tileSize, tileSize);
        geo.scale(-1, 1, 1);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(dist - (tile.col + 0.5) * tileSize, dist - (tile.row + 0.5) * tileSize, 0);
        const g = targetGroup.children.find(c => c.name === tile.face);
        if (g) g.add(mesh);
        if (targetGroup === pendingGroup) {
          loadedCount++; if (loadedCount === inViewTiles.length) finalizeSwap();
        }
      });
    };

    if (inViewTiles.length === 0) finalizeSwap();
    else inViewTiles.forEach(tile => loadTile(tile, pendingGroup));
  }, []);

  useEffect(() => {
    if (!activeImage?.result || !containerRef.current) return;

    if (!sceneRef.current) {
      const width = containerRef.current.clientWidth || 800;
      const height = containerRef.current.clientHeight || 600;
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(width, height);
      containerRef.current.appendChild(renderer.domElement);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableZoom = false; 
      controls.rotateSpeed = -0.4; 
      controls.enableDamping = true;
      camera.position.set(0, 0, 0.1); 
      controls.update();
      
      const facesGroup = new THREE.Group();
      const pendingGroup = new THREE.Group();
      const markersGroup = new THREE.Group();
      scene.add(facesGroup);
      scene.add(pendingGroup);
      scene.add(markersGroup);
      
      sceneRef.current = { scene, camera, renderer, controls, facesGroup, pendingGroup, markersGroup, currentImageId: null };
      
      const animate = () => {
        if (!sceneRef.current) return;
        requestAnimationFrame(animate);
        sceneRef.current.controls.update();
        sceneRef.current.renderer.render(sceneRef.current.scene, sceneRef.current.camera);
      };
      animate();

      const handleWheel = (e: WheelEvent) => {
        if (!sceneRef.current) return;
        e.preventDefault();
        let newFov = sceneRef.current.camera.fov + e.deltaY * 0.05;
        newFov = Math.max(10, Math.min(100, newFov));
        sceneRef.current.camera.fov = newFov;
        sceneRef.current.camera.updateProjectionMatrix();
        setZoomLevel(newFov);
      };
      containerRef.current.addEventListener('wheel', handleWheel, { passive: false });

      const handleClick = (e: MouseEvent) => {
        if (!sceneRef.current || !activeImageIdRef.current) return;
        const rect = renderer.domElement.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(x, y), sceneRef.current.camera);
        
        const markerIntersects = raycaster.intersectObjects(sceneRef.current.markersGroup.children, true);
        if (markerIntersects.length > 0) {
          const markerId = markerIntersects[0].object.userData.markerId || markerIntersects[0].object.parent?.userData.markerId;
          const marker = imagesRef.current.find(img => img.id === activeImageIdRef.current)?.markers.find(m => m.id === markerId);
          
          if (marker) {
            if (editModeRef.current !== 'NONE') {
              setSelectedMarkerId(markerId);
            } else if (marker.type === 'HOTSPOT' && marker.target) {
              setActiveImageId(marker.target.imageId);
              if (marker.target.fov) setZoomLevel(marker.target.fov);
              if (sceneRef.current) {
                if (marker.target.fov) sceneRef.current.camera.fov = marker.target.fov;
                if (marker.target.rotation) sceneRef.current.camera.rotation.set(marker.target.rotation.x, marker.target.rotation.y, marker.target.rotation.z);
                sceneRef.current.camera.updateProjectionMatrix();
              }
            }
            return;
          }
        }

        if (editModeRef.current !== 'NONE') {
          const faceIntersects = raycaster.intersectObjects(sceneRef.current.facesGroup.children, true);
          if (faceIntersects.length > 0) {
            const hit = faceIntersects[0].point;
            const pos = hit.normalize().multiplyScalar(45);
            const newMarker: Marker = {
              id: Math.random().toString(36).substr(2, 9),
              type: editModeRef.current,
              position: { x: pos.x, y: pos.y, z: pos.z },
              content: editModeRef.current === 'TEXT' ? 'Label Name' : undefined,
              color: '#ffffff'
            };
            
            const currentImgId = activeImageIdRef.current;
            setImages(prev => prev.map(img => img.id === currentImgId ? { ...img, markers: [...img.markers, newMarker] } : img));
            setEditMode('NONE');
            setSelectedMarkerId(newMarker.id);
          }
        }
      };
      renderer.domElement.addEventListener('click', handleClick);
    }

    if (sceneRef.current.currentImageId !== activeImageId) {
      sceneRef.current.currentImageId = activeImageId;
      createCubeInScene(activeImage.result.level1, true);
      setTimeout(() => {
        if (activeImageId === sceneRef.current?.currentImageId) createCubeInScene(activeImage.result.level2);
      }, 50);
    }
    renderMarkers();
  }, [activeImageId, activeImage?.result, activeImage?.markers, renderMarkers, createCubeInScene]);

  useEffect(() => {
    if (!activeImage?.result || !sceneRef.current) return;
    let targetLevel = 1;
    if (zoomLevel <= 35) targetLevel = 3;      
    else if (zoomLevel >= 90) targetLevel = 1; 
    else targetLevel = 2; 

    if (targetLevel !== activeLOD) {
      if (targetLevel === 3) createCubeInScene(activeImage.result.level3);
      else if (targetLevel === 2) createCubeInScene(activeImage.result.level2);
      else createCubeInScene(activeImage.result.level1);
    }
  }, [zoomLevel, activeImage?.result, activeLOD, createCubeInScene]);

  const updateMarker = (markerId: string, updates: Partial<Marker>) => {
    setImages(prev => prev.map(img => img.id === activeImageId ? {
      ...img,
      markers: img.markers.map(m => m.id === markerId ? { ...m, ...updates } : m)
    } : img));
  };

  const deleteMarker = (markerId: string) => {
    setImages(prev => prev.map(img => img.id === activeImageId ? {
      ...img,
      markers: img.markers.filter(m => m.id !== markerId)
    } : img));
    setSelectedMarkerId(null);
  };

  const selectedMarker = activeImage?.markers.find(m => m.id === selectedMarkerId);
  const targetImageForPicker = images.find(img => img.id === selectedMarker?.target?.imageId);

  const handlePickerConfirm = (fov: number, rotation: { x: number; y: number; z: number }) => {
    if (selectedMarker) {
      updateMarker(selectedMarker.id, {
        target: { ...selectedMarker.target!, fov, rotation }
      });
    }
    setIsPickingTargetView(false);
  };

  const handleDownloadOffline = async () => {
    const completedImages = images.filter(img => img.status === 'COMPLETED');
    if (completedImages.length === 0 || !JSZip) return;
    setIsDownloading(true);
    const zip = new JSZip();
    const allDataForOffline: any[] = [];

    for (const img of completedImages) {
      const imgFolder = zip.folder(`assets/${img.id}`);
      const exportItem: any = { id: img.id, name: img.name, level1: [], level2: [], level3: [], markers: img.markers };
      const processLevel = (lvlKey: string) => {
        const tiles = (img.result as any)[lvlKey];
        tiles.forEach((tile: TileData) => {
          const fileName = `${lvlKey}_${tile.face}_r${tile.row}_c${tile.col}.jpg`;
          imgFolder.file(fileName, tile.dataUrl.split(',')[1], { base64: true });
          exportItem[lvlKey].push({ ...tile, dataUrl: `assets/${img.id}/${fileName}` });
        });
      };
      processLevel('level1'); processLevel('level2'); processLevel('level3');
      allDataForOffline.push(exportItem);
    }

    const htmlContent = `<!DOCTYPE html><html><head><title>360 Virtual Tour</title><style>body{margin:0;overflow:hidden;background:#000;font-family:sans-serif;}#container{width:100vw;height:100vh;}#menu{position:absolute;top:20px;left:20px;z-index:100;background:rgba(0,0,0,0.8);color:white;padding:20px;border-radius:12px;max-width:250px;transition:transform 0.3s;}#menu.collapsed{transform:translateX(-280px);}.img-item{padding:8px 12px;margin-bottom:5px;cursor:pointer;border-radius:6px;font-size:12px;overflow:hidden;text-overflow:ellipsis;}.img-item.active{background:#4f46e5;}</style><script type="importmap">{"imports":{"three":"https://esm.sh/three@0.160.0","three/examples/jsm/controls/OrbitControls":"https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls"}}</script></head><body><div id="menu"><h2>Gallery</h2><div id="img-list"></div></div><div id="container"></div><script type="module">import * as THREE from 'three';import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls';const allImages=${JSON.stringify(allDataForOffline)};let currentImageData=allImages[0];const container=document.getElementById('container');const scene=new THREE.Scene();const camera=new THREE.PerspectiveCamera(60,window.innerWidth/window.innerHeight,0.1,1000);const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(window.innerWidth,window.innerHeight);container.appendChild(renderer.domElement);const controls=new OrbitControls(camera,renderer.domElement);controls.enableZoom=false;controls.rotateSpeed=-0.4;controls.enableDamping=true;camera.position.set(0,0,0.1);const facesGroup=new THREE.Group();const pendingGroup=new THREE.Group();const markersGroup=new THREE.Group();scene.add(facesGroup);scene.add(pendingGroup);scene.add(markersGroup);const loader=new THREE.TextureLoader();let activeLOD=0;function updateLOD(level,force=false,isFast=false){if(activeLOD===level&&!force)return;const dist=50;const configs={px:{pos:[dist,0,0],rot:[0,-Math.PI/2,0],n:new THREE.Vector3(1,0,0)},nx:{pos:[-dist,0,0],rot:[0,Math.PI/2,0],n:new THREE.Vector3(-1,0,0)},py:{pos:[0,dist,0],rot:[Math.PI/2,0,Math.PI],n:new THREE.Vector3(0,1,0)},ny:{pos:[0,-dist,0],rot:[-Math.PI/2,0,Math.PI],n:new THREE.Vector3(0,-1,0)},pz:{pos:[0,0,dist],rot:[0,Math.PI,0],n:new THREE.Vector3(0,0,1)},nz:{pos:[0,0,-dist],rot:[0,0,0],n:new THREE.Vector3(0,0,-1)}};pendingGroup.clear();const currentLevelData=currentImageData['level'+level];const tileSize=(dist*2)/Math.sqrt(currentLevelData.length/6);camera.updateMatrixWorld();const camDir=new THREE.Vector3();camera.getWorldDirection(camDir);const inView=currentLevelData.filter(t=>isFast||camDir.dot(configs[t.face].n)>-0.3);const finalize=()=>{facesGroup.clear();while(pendingGroup.children.length>0)facesGroup.add(pendingGroup.children[0]);activeLOD=level;if(!isFast)currentLevelData.filter(t=>!inView.includes(t)).forEach(t=>loadTile(t,facesGroup));};const loadTile=(t,targetGroup)=>{loader.load(t.dataUrl,tex=>{tex.colorSpace=THREE.SRGBColorSpace;const mat=new THREE.MeshBasicMaterial({map:tex,side:THREE.DoubleSide});const geo=new THREE.PlaneGeometry(tileSize,tileSize);geo.scale(-1,1,1);const m=new THREE.Mesh(geo,mat);m.position.set(dist-(t.col+0.5)*tileSize,dist-(t.row+0.5)*tileSize,0);let g=targetGroup.children.find(c=>c.name===t.face);if(!g){g=new THREE.Group();g.position.set(...configs[t.face].pos);g.rotation.set(...configs[t.face].rot);g.name=t.face;targetGroup.add(g);}g.add(m);if(targetGroup===pendingGroup){loaded++;if(loaded===inView.length)finalize();}});};let loaded=0;if(inView.length===0)finalize();else inView.forEach(t=>loadTile(t,pendingGroup));}function renderMarkers(){markersGroup.clear();currentImageData.markers.forEach(m=>{if(m.type==='HOTSPOT'){const group=new THREE.Group();group.position.set(m.position.x,m.position.y,m.position.z);group.lookAt(0,0,0);group.userData={markerId:m.id};const iGeo=new THREE.CircleGeometry(0.7,32);const iMat=new THREE.MeshBasicMaterial({color:0xffffff});const iMesh=new THREE.Mesh(iGeo,iMat);const oGeo=new THREE.CircleGeometry(1.5,32);const oMat=new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0.5});const oMesh=new THREE.Mesh(oGeo,oMat);oMesh.position.z=-0.01;group.add(iMesh);group.add(oMesh);group.onBeforeRender=()=>{const t=performance.now()*0.003;iMesh.scale.setScalar(1+Math.sin(t*1.5)*0.2);oMesh.scale.setScalar(1+Math.sin(t*1.5)*0.4);oMat.opacity=0.3+Math.sin(t*1.5)*0.2;};markersGroup.add(group);}else{const canvas=document.createElement('canvas');const ctx=canvas.getContext('2d');canvas.width=256;canvas.height=128;ctx.font='bold 32px sans-serif';ctx.fillStyle='white';ctx.textAlign='center';ctx.fillText(m.content||'',128,64);const tex=new THREE.CanvasTexture(canvas);const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:tex}));sprite.position.set(m.position.x,m.position.y,m.position.z);sprite.scale.set(8,4,1);markersGroup.add(sprite);}});}function selectImage(id){currentImageData=allImages.find(img=>img.id===id);activeLOD=0;updateLOD(1,true,true);renderMarkers();setTimeout(()=>updateLOD(2),100);}const imgList=document.getElementById('img-list');allImages.forEach(img=>{const el=document.createElement('div');el.className='img-item';el.textContent=img.name;el.onclick=()=>selectImage(img.id);imgList.appendChild(el);});window.addEventListener('click',e=>{const rect=renderer.domElement.getBoundingClientRect();const mouse=new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);const ray=new THREE.Raycaster();ray.setFromCamera(mouse,camera);const hits=ray.intersectObjects(markersGroup.children,true);if(hits.length>0){let obj=hits[0].object;while(obj.parent && !obj.userData.markerId) obj=obj.parent;const m=currentImageData.markers.find(mm=>mm.id===obj.userData.markerId);if(m&&m.target){selectImage(m.target.imageId);if(m.target.fov)camera.fov=m.target.fov;if(m.target.rotation)camera.rotation.set(m.target.rotation.x,m.target.rotation.y,m.target.rotation.z);camera.updateProjectionMatrix();}}});window.addEventListener('wheel',e=>{camera.fov=Math.max(10,Math.min(100,camera.fov+e.deltaY*0.05));camera.updateProjectionMatrix();if(camera.fov<=35)updateLOD(3);else if(camera.fov>=90)updateLOD(1);else updateLOD(2);},{passive:false});function animate(){requestAnimationFrame(animate);controls.update();renderer.render(scene,camera);}animate();selectImage(allImages[0].id);</script></body></html>`;
    zip.file("index.html", htmlContent);
    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const link = document.createElement("a");
    link.href = url; link.download = `360_Virtual_Tour.zip`; link.click();
    setIsDownloading(false);
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-200 overflow-hidden font-sans select-none">
      {isPickingTargetView && targetImageForPicker && (
        <TargetViewPicker 
          image={targetImageForPicker}
          initialFov={selectedMarker?.target?.fov}
          initialRotation={selectedMarker?.target?.rotation}
          onClose={() => setIsPickingTargetView(false)}
          onConfirm={handlePickerConfirm}
        />
      )}

      <aside className={`border-r border-slate-800 flex flex-col bg-slate-900/80 backdrop-blur-3xl z-30 transition-all duration-500 ease-in-out ${isSidebarCollapsed ? 'w-0 opacity-0 overflow-hidden' : 'w-80 opacity-100'}`}>
        <div className="p-6 border-b border-slate-800">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
                <div className="bg-gradient-to-br from-indigo-500 to-purple-600 p-2.5 rounded-2xl shadow-xl">
                    <Camera className="w-5 h-5 text-white" />
                </div>
                <div className="min-w-0">
                    <h1 className="text-base font-black tracking-tight text-white leading-tight">360 TOUR</h1>
                    <span className="text-[10px] text-slate-500 font-mono tracking-widest uppercase">Authoring Tool</span>
                </div>
            </div>
            <button onClick={() => setIsSidebarCollapsed(true)} className="p-2 hover:bg-white/5 rounded-xl transition-colors">
                <PanelLeftClose className="w-5 h-5 text-slate-400" />
            </button>
          </div>
          
          <div className="flex gap-2">
            <label className="flex-1 flex items-center justify-center gap-2 bg-white hover:bg-slate-200 text-black transition-all py-3.5 rounded-2xl cursor-pointer text-xs font-black shadow-xl">
                <Plus className="w-4 h-4" /> ADD SCENE
                <input type="file" className="hidden" accept="image/*" multiple onChange={(e) => handleFiles(e.target.files)} />
            </label>
            {images.some(img => img.status === 'COMPLETED') && (
                <button 
                  onClick={handleDownloadOffline}
                  disabled={isDownloading}
                  className="p-3.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl shadow-xl transition-all disabled:opacity-50"
                  title="Export Virtual Tour"
                >
                    {isDownloading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
                </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="p-4 space-y-4">
            {images.length > 0 && activeImageId && (
              <div className="bg-slate-800/40 p-4 rounded-2xl border border-white/5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em]">Marker Studio</h3>
                  <Crosshair className={`w-4 h-4 ${editMode !== 'NONE' ? 'text-indigo-400 animate-pulse' : 'text-slate-600'}`} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button 
                    onClick={() => setEditMode(editMode === 'HOTSPOT' ? 'NONE' : 'HOTSPOT')}
                    className={`flex items-center gap-2 p-3 rounded-xl border text-[10px] font-black uppercase tracking-wider transition-all ${editMode === 'HOTSPOT' ? 'bg-indigo-500 border-indigo-400 text-white shadow-lg' : 'bg-slate-900 border-white/5 hover:border-white/10 text-slate-400'}`}
                  >
                    <MapPin className="w-3.5 h-3.5" /> Hotspot
                  </button>
                  <button 
                    onClick={() => setEditMode(editMode === 'TEXT' ? 'NONE' : 'TEXT')}
                    className={`flex items-center gap-2 p-3 rounded-xl border text-[10px] font-black uppercase tracking-wider transition-all ${editMode === 'TEXT' ? 'bg-indigo-500 border-indigo-400 text-white shadow-lg' : 'bg-slate-900 border-white/5 hover:border-white/10 text-slate-400'}`}
                  >
                    <Type className="w-3.5 h-3.5" /> Label
                  </button>
                </div>

                {selectedMarker && (
                  <div className="mt-4 p-4 bg-black/40 rounded-xl border border-white/10 space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="flex items-center justify-between">
                       <span className="text-[10px] font-black text-indigo-400 uppercase">Marker Config</span>
                       <button onClick={() => deleteMarker(selectedMarker.id)} className="p-1.5 hover:bg-red-500/10 text-slate-500 hover:text-red-400 rounded-lg transition-colors">
                        <Trash2 className="w-4 h-4" />
                       </button>
                    </div>
                    
                    {selectedMarker.type === 'TEXT' ? (
                      <input 
                        type="text" 
                        value={selectedMarker.content} 
                        onChange={(e) => updateMarker(selectedMarker.id, { content: e.target.value })}
                        className="w-full bg-slate-900 border border-white/5 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                        placeholder="Label text..."
                      />
                    ) : (
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <label className="text-[9px] font-black uppercase text-slate-600">Target Scene</label>
                          <select 
                            value={selectedMarker.target?.imageId || ''} 
                            onChange={(e) => updateMarker(selectedMarker.id, { target: { ...selectedMarker.target!, imageId: e.target.value } })}
                            className="w-full bg-slate-900 border border-white/5 rounded-lg px-3 py-2 text-xs text-white focus:outline-none"
                          >
                            <option value="">Select Target...</option>
                            {images.filter(img => img.status === 'COMPLETED').map(img => (
                              <option key={img.id} value={img.id}>{img.name}</option>
                            ))}
                          </select>
                        </div>
                        {selectedMarker.target?.imageId && (
                          <button 
                            onClick={() => setIsPickingTargetView(true)}
                            className="w-full flex items-center justify-center gap-2 p-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-[9px] font-black uppercase tracking-widest text-white transition-all shadow-lg"
                          >
                            <Save className="w-3.5 h-3.5" /> Set Target View
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <h3 className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] px-2 mb-3">Scenes</h3>
              {images.map(img => (
                <button
                  key={img.id}
                  onClick={() => img.status === 'COMPLETED' && setActiveImageId(img.id)}
                  className={`w-full text-left p-4 rounded-2xl border transition-all relative ${
                    activeImageId === img.id ? 'bg-indigo-600/10 border-indigo-500' : 'bg-slate-900/40 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className={`text-[11px] font-bold truncate ${activeImageId === img.id ? 'text-indigo-400' : 'text-slate-200'}`}>{img.name}</p>
                    <div className="flex items-center gap-1.5">
                      {img.status === 'PROCESSING' ? <Loader2 className="w-3 h-3 text-indigo-500 animate-spin" /> : 
                       img.status === 'COMPLETED' ? <CheckCircle2 className="w-3 h-3 text-green-500" /> : <Clock className="w-3 h-3 text-slate-600" />}
                    </div>
                  </div>
                  {img.status === 'PROCESSING' && (
                    <div className="absolute bottom-0 left-0 h-1 bg-indigo-500 transition-all rounded-b-2xl" style={{ width: `${img.progress}%` }} />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      </aside>

      <main 
        className={`flex-1 relative flex flex-col bg-black overflow-hidden transition-all duration-500 ${isDragging ? 'scale-[0.99] bg-slate-900 ring-8 ring-indigo-500/20' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files); }}
      >
        {isSidebarCollapsed && (
            <button onClick={() => setIsSidebarCollapsed(false)} className="absolute top-6 left-6 z-40 p-3 bg-black/40 backdrop-blur-xl border border-white/10 rounded-2xl text-white">
                <PanelLeft className="w-6 h-6" />
            </button>
        )}

        {!activeImageId ? (
          <div className="flex-1 flex flex-col items-center justify-center p-12 text-center bg-slate-950">
            <div className="w-32 h-32 bg-slate-900/50 rounded-[2.5rem] flex items-center justify-center mb-8 border border-slate-800 rotate-6 transition-transform hover:rotate-0">
              <ImageIcon className="w-16 h-16 text-slate-700" />
            </div>
            <h2 className="text-4xl font-black mb-4 text-white tracking-tighter">Equirectangular to Cubemap</h2>
            <p className="text-slate-500 text-base max-w-sm mb-10">Upload a panorama and start building your interactive virtual tour.</p>
          </div>
        ) : (
          <div className="flex-1 relative">
             {editMode !== 'NONE' && (
               <div className="absolute top-8 left-1/2 -translate-x-1/2 z-20 bg-indigo-600 text-white px-6 py-3 rounded-full font-black text-[10px] uppercase tracking-widest shadow-2xl flex items-center gap-3 animate-bounce">
                  <Crosshair className="w-4 h-4" /> Click to place {editMode.toLowerCase()}
               </div>
             )}
             <div className="absolute bottom-8 right-8 z-20 pointer-events-none flex flex-col items-end gap-3">
                <div className="bg-black/40 backdrop-blur-2xl p-4 rounded-2xl border border-white/10 flex items-center gap-6 pointer-events-auto">
                  <div className="flex items-center gap-2 text-indigo-400">
                    <ZoomIn className="w-4 h-4" />
                    <span className="text-xs font-mono font-black">{Math.round(zoomLevel)}°</span>
                  </div>
                  <div className="flex gap-1.5">
                    {[1, 2, 3].map(lvl => (
                      <div key={lvl} className={`w-8 h-1 rounded-full ${lvl <= activeLOD ? 'bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]' : 'bg-slate-800'}`} />
                    ))}
                  </div>
                </div>
                <div className="bg-black/60 backdrop-blur-md px-4 py-2 rounded-full border border-white/5 flex items-center gap-3">
                  <Move className="w-3 h-3 text-slate-500" />
                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Scroll to Zoom</span>
                </div>
             </div>
             <div ref={containerRef} className="w-full h-full bg-black cursor-crosshair" />
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
