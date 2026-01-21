
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Camera, Image as ImageIcon, Loader2, ZoomIn, Move, AlertCircle, CheckCircle2, Plus, Clock, ChevronRight, Download, PanelLeftClose, PanelLeft } from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { ImageItem, TileData } from './types';

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

const App: React.FC = () => {
  const [images, setImages] = useState<ImageItem[]>([]);
  const [activeImageId, setActiveImageId] = useState<string | null>(null);
  const [isProcessingId, setIsProcessingId] = useState<string | null>(null);
  // Default Zoom FOV 60
  const [zoomLevel, setZoomLevel] = useState(60);
  const [activeLOD, setActiveLOD] = useState<number>(2);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    facesGroup: THREE.Group;
    pendingGroup: THREE.Group;
    currentImageId: string | null;
  } | null>(null);

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const newItems: ImageItem[] = Array.from(files).map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      name: file.name,
      file,
      status: 'PENDING',
      progress: 0
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
    pendingGroup.visible = false; 

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

    const inViewTiles: TileData[] = [];
    const outViewTiles: TileData[] = [];

    levelData.forEach(tile => {
      const config = faceConfigs[tile.face];
      const dot = camDir.dot(config.normal);
      if (dot > -0.3 || isFastInitial) { // In fast mode, load all Level 1 tiles
        inViewTiles.push(tile);
      } else {
        outViewTiles.push(tile);
      }
    });

    let loadedCount = 0;
    const totalInView = inViewTiles.length;

    const finalizeSwap = () => {
      facesGroup.clear();
      while(pendingGroup.children.length > 0) {
        facesGroup.add(pendingGroup.children[0]);
      }
      setActiveLOD(levelData[0].level);
      if (!isFastInitial) loadRemainingTiles();
    };

    const checkAllInViewLoaded = () => {
      loadedCount++;
      if (loadedCount === totalInView) {
        finalizeSwap();
      }
    };

    const loadRemainingTiles = () => {
      outViewTiles.forEach(tile => {
        loader.load(tile.dataUrl, (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearFilter;
          const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
          const geometry = new THREE.PlaneGeometry(tileSize, tileSize);
          geometry.scale(-1, 1, 1);
          const mesh = new THREE.Mesh(geometry, material);
          const localX = dist - (tile.col + 0.5) * tileSize;
          const localY = dist - (tile.row + 0.5) * tileSize;
          mesh.position.set(localX, localY, 0);
          const group = facesGroup.children.find(c => c.name === tile.face);
          if (group) group.add(mesh);
        });
      });
    };

    if (totalInView === 0) {
       finalizeSwap();
    } else {
      inViewTiles.forEach(tile => {
        loader.load(tile.dataUrl, (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearFilter;
          const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
          const geometry = new THREE.PlaneGeometry(tileSize, tileSize);
          geometry.scale(-1, 1, 1);
          const mesh = new THREE.Mesh(geometry, material);
          const localX = dist - (tile.col + 0.5) * tileSize;
          const localY = dist - (tile.row + 0.5) * tileSize;
          mesh.position.set(localX, localY, 0);
          faceGroups[tile.face].add(mesh);
          checkAllInViewLoaded();
        });
      });
    }
  }, []);

  const activeImage = images.find(img => img.id === activeImageId);

  useEffect(() => {
    if (!sceneRef.current || !containerRef.current) return;
    const handleResize = () => {
      if (!sceneRef.current || !containerRef.current) return;
      const width = containerRef.current.clientWidth;
      const height = containerRef.current.clientHeight;
      sceneRef.current.camera.aspect = width / height;
      sceneRef.current.camera.updateProjectionMatrix();
      sceneRef.current.renderer.setSize(width, height);
    };
    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [isSidebarCollapsed]);

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
      scene.add(facesGroup);
      scene.add(pendingGroup);
      
      sceneRef.current = { scene, camera, renderer, controls, facesGroup, pendingGroup, currentImageId: null };
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
    }

    if (sceneRef.current.currentImageId !== activeImageId) {
      sceneRef.current.currentImageId = activeImageId;
      // Start with Level 1 (Fast) then immediate Level 2 (Correct)
      createCubeInScene(activeImage.result.level1, true);
      setTimeout(() => {
        if (activeImageId === sceneRef.current?.currentImageId) {
            createCubeInScene(activeImage.result.level2);
        }
      }, 50);
    }
  }, [activeImageId, activeImage?.result, createCubeInScene]);

  useEffect(() => {
    if (!activeImage?.result || !sceneRef.current) return;
    let targetLevel = 1;
    if (zoomLevel <= 35) targetLevel = 3;      
    else if (zoomLevel >= 90) targetLevel = 1; 
    else targetLevel = 2; // Default for range (35 to 90)

    if (targetLevel !== activeLOD) {
      if (targetLevel === 3) createCubeInScene(activeImage.result.level3);
      else if (targetLevel === 2) createCubeInScene(activeImage.result.level2);
      else createCubeInScene(activeImage.result.level1);
    }
  }, [zoomLevel, activeImage?.result, activeLOD, createCubeInScene]);

  const handleDownloadOffline = async () => {
    const completedImages = images.filter(img => img.status === 'COMPLETED');
    if (completedImages.length === 0 || !JSZip) return;
    
    setIsDownloading(true);
    const zip = new JSZip();
    const allDataForOffline: any[] = [];

    for (const img of completedImages) {
      const imgFolder = zip.folder(`assets/${img.id}`);
      const exportItem: any = { id: img.id, name: img.name, level1: [], level2: [], level3: [] };
      
      const processLevel = (lvlKey: string) => {
        const tiles = (img.result as any)[lvlKey];
        tiles.forEach((tile: TileData) => {
          const fileName = `${lvlKey}_${tile.face}_r${tile.row}_c${tile.col}.jpg`;
          const base64Data = tile.dataUrl.split(',')[1];
          imgFolder.file(fileName, base64Data, { base64: true });
          exportItem[lvlKey].push({ ...tile, dataUrl: `assets/${img.id}/${fileName}` });
        });
      };

      processLevel('level1');
      processLevel('level2');
      processLevel('level3');
      allDataForOffline.push(exportItem);
    }

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <title>360 Offline Multi-Image Viewer</title>
    <style>
        body { margin: 0; overflow: hidden; background: #000; font-family: sans-serif; }
        #container { width: 100vw; height: 100vh; }
        #menu { 
            position: absolute; top: 20px; left: 20px; z-index: 100; 
            background: rgba(0,0,0,0.8); color: white; padding: 20px; 
            border-radius: 12px; border: 1px solid rgba(255,255,255,0.1);
            max-width: 250px; transition: transform 0.3s;
        }
        #menu.collapsed { transform: translateX(-280px); }
        h2 { margin: 0 0 15px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #818cf8; }
        .img-item { 
            padding: 8px 12px; margin-bottom: 5px; cursor: pointer; border-radius: 6px; 
            font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            transition: background 0.2s;
        }
        .img-item:hover { background: rgba(255,255,255,0.1); }
        .img-item.active { background: #4f46e5; }
        #toggle-menu { position: absolute; right: -40px; top: 0; background: rgba(0,0,0,0.8); border: none; color: white; padding: 10px; cursor: pointer; border-radius: 0 8px 8px 0; }
    </style>
    <script type="importmap">
    { "imports": { "three": "https://esm.sh/three@0.160.0", "three/examples/jsm/controls/OrbitControls": "https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls" } }
    </script>
</head>
<body>
<div id="menu">
    <button id="toggle-menu">☰</button>
    <h2>Gallery</h2>
    <div id="img-list"></div>
</div>
<div id="container"></div>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

const allImages = ${JSON.stringify(allDataForOffline)};
let currentImageData = allImages[0];
const container = document.getElementById('container');
const imgList = document.getElementById('img-list');
const menu = document.getElementById('menu');
document.getElementById('toggle-menu').onclick = () => menu.classList.toggle('collapsed');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableZoom = false; controls.rotateSpeed = -0.4; controls.enableDamping = true;
camera.position.set(0, 0, 0.1);

const facesGroup = new THREE.Group();
const pendingGroup = new THREE.Group();
scene.add(facesGroup);
scene.add(pendingGroup);

const loader = new THREE.TextureLoader();
let activeLOD = 0;

function updateLOD(level, force = false, isFast = false) {
    if (activeLOD === level && !force) return;
    
    const dist = 50;
    const configs = {
        px: { pos: [dist,0,0], rot: [0,-Math.PI/2,0], n: new THREE.Vector3(1,0,0) }, 
        nx: { pos: [-dist,0,0], rot: [0,Math.PI/2,0], n: new THREE.Vector3(-1,0,0) },
        py: { pos: [0,dist,0], rot: [Math.PI/2,0,Math.PI], n: new THREE.Vector3(0,1,0) }, 
        ny: { pos: [0,-dist,0], rot: [-Math.PI/2,0,Math.PI], n: new THREE.Vector3(0,-1,0) },
        pz: { pos: [0,0,dist], rot: [0,Math.PI,0], n: new THREE.Vector3(0,0,1) }, 
        nz: { pos: [0,0,-dist], rot: [0,0,0], n: new THREE.Vector3(0,0,-1) }
    };
    
    pendingGroup.clear();
    const currentLevelData = currentImageData['level' + level];
    const tilesPerSide = Math.sqrt(currentLevelData.length / 6);
    const tileSize = (dist * 2) / tilesPerSide;
    
    const faceGroups = {};
    Object.entries(configs).forEach(([n, c]) => {
        const g = new THREE.Group(); g.position.set(...c.pos); g.rotation.set(...c.rot); g.name = n;
        pendingGroup.add(g); faceGroups[n] = g;
    });

    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    
    const inView = currentLevelData.filter(t => isFast || camDir.dot(configs[t.face].n) > -0.3);
    const outView = currentLevelData.filter(t => !isFast && camDir.dot(configs[t.face].n) <= -0.3);
    
    let loaded = 0;
    const finalize = () => {
        facesGroup.clear();
        while(pendingGroup.children.length > 0) facesGroup.add(pendingGroup.children[0]);
        activeLOD = level;
        if (!isFast) outView.forEach(t => loadTile(t, facesGroup));
    };

    const loadTile = (t, targetGroup) => {
        loader.load(t.dataUrl, tex => {
            tex.colorSpace = THREE.SRGBColorSpace;
            const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
            const geo = new THREE.PlaneGeometry(tileSize, tileSize);
            geo.scale(-1, 1, 1);
            const m = new THREE.Mesh(geo, mat);
            m.position.set(dist - (t.col + 0.5) * tileSize, dist - (t.row + 0.5) * tileSize, 0);
            const g = targetGroup.children.find(c => c.name === t.face);
            if (g) g.add(m);
            if (targetGroup === pendingGroup) {
                loaded++; if (loaded === inView.length) finalize();
            }
        });
    };

    if (inView.length === 0) finalize();
    else inView.forEach(t => loadTile(t, pendingGroup));
}

function selectImage(id) {
    currentImageData = allImages.find(img => img.id === id);
    activeLOD = 0;
    updateLOD(1, true, true);
    setTimeout(() => updateLOD(2), 100);
    document.querySelectorAll('.img-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === id);
    });
}

allImages.forEach(img => {
    const el = document.createElement('div');
    el.className = 'img-item' + (img.id === currentImageData.id ? ' active' : '');
    el.textContent = img.name;
    el.dataset.id = img.id;
    el.onclick = () => selectImage(img.id);
    imgList.appendChild(el);
});

function animate() { requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }
animate();

window.addEventListener('wheel', e => {
    camera.fov = Math.max(10, Math.min(100, camera.fov + e.deltaY * 0.05));
    camera.updateProjectionMatrix();
    if (camera.fov <= 35) updateLOD(3); else if (camera.fov >= 90) updateLOD(1); else updateLOD(2);
}, { passive: false });

// Init with Fast L1 then sync L2
updateLOD(1, true, true);
setTimeout(() => updateLOD(2), 100);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
</script>
</body>
</html>`;

    zip.file("index.html", htmlContent);
    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const link = document.createElement("a");
    link.href = url;
    link.download = `360_Gallery_Offline.zip`;
    link.click();
    setIsDownloading(false);
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-200 overflow-hidden font-sans select-none">
      <aside className={`border-r border-slate-800 flex flex-col bg-slate-900/80 backdrop-blur-3xl z-30 transition-all duration-500 ease-in-out ${isSidebarCollapsed ? 'w-0 opacity-0 overflow-hidden' : 'w-80 opacity-100'}`}>
        <div className="p-6 border-b border-slate-800">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
                <div className="bg-gradient-to-br from-indigo-500 to-purple-600 p-2.5 rounded-2xl shadow-xl">
                    <Camera className="w-5 h-5 text-white" />
                </div>
                <div className="min-w-0">
                    <h1 className="text-base font-black tracking-tight text-white leading-tight">360 VIEWER</h1>
                    <span className="text-[10px] text-slate-500 font-mono tracking-widest uppercase">Multi-Tiling</span>
                </div>
            </div>
            <button onClick={() => setIsSidebarCollapsed(true)} className="p-2 hover:bg-white/5 rounded-xl transition-colors">
                <PanelLeftClose className="w-5 h-5 text-slate-400" />
            </button>
          </div>
          
          <div className="flex gap-2">
            <label className="flex-1 flex items-center justify-center gap-2 bg-white hover:bg-slate-200 text-black transition-all py-3.5 rounded-2xl cursor-pointer text-xs font-black shadow-xl group overflow-hidden relative">
                <Plus className="w-4 h-4 transition-transform group-hover:rotate-90" />
                ADD
                <input type="file" className="hidden" accept="image/*" multiple onChange={(e) => handleFiles(e.target.files)} />
            </label>
            {images.some(img => img.status === 'COMPLETED') && (
                <button 
                  onClick={handleDownloadOffline}
                  disabled={isDownloading}
                  className="p-3.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl shadow-xl transition-all disabled:opacity-50"
                  title="Download All Offline"
                >
                    {isDownloading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
                </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
          {images.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center opacity-20 text-center p-8 space-y-4">
              <ImageIcon className="w-16 h-16 stroke-[1px]" />
              <p className="text-[10px] uppercase font-black tracking-[0.2em]">Queue empty</p>
            </div>
          ) : (
            images.map(img => (
              <button
                key={img.id}
                onClick={() => img.status === 'COMPLETED' && setActiveImageId(img.id)}
                className={`w-full text-left p-4 rounded-2xl border transition-all relative group ${
                  activeImageId === img.id ? 'bg-indigo-600/10 border-indigo-500' : 'bg-slate-900/40 border-slate-800 hover:border-slate-700'
                } ${img.status !== 'COMPLETED' ? 'cursor-default' : 'cursor-pointer'}`}
              >
                <div className="flex items-start justify-between gap-3 relative z-10">
                  <div className="flex-1 min-w-0">
                    <p className={`text-[11px] font-bold truncate ${activeImageId === img.id ? 'text-indigo-400' : 'text-slate-200'}`}>{img.name}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      {img.status === 'PROCESSING' && <Loader2 className="w-3 h-3 text-indigo-500 animate-spin" />}
                      {img.status === 'PENDING' && <Clock className="w-3 h-3 text-slate-600" />}
                      {img.status === 'COMPLETED' && <CheckCircle2 className="w-3 h-3 text-green-500" />}
                      {img.status === 'ERROR' && <AlertCircle className="w-3 h-3 text-red-500" />}
                      <span className="text-[9px] font-black text-slate-500 uppercase tracking-wider">
                        {img.status === 'PROCESSING' ? `${img.progress}%` : img.status}
                      </span>
                    </div>
                  </div>
                  {img.status === 'COMPLETED' && <ChevronRight className="w-4 h-4 text-slate-700" />}
                </div>
                {img.status === 'PROCESSING' && (
                  <div className="absolute bottom-0 left-0 h-1 bg-indigo-500 transition-all duration-300 rounded-b-2xl" style={{ width: `${img.progress}%` }} />
                )}
              </button>
            ))
          )}
        </div>
      </aside>

      <main 
        className={`flex-1 relative flex flex-col bg-black overflow-hidden transition-all duration-500 ${isDragging ? 'ring-8 ring-indigo-500/30 ring-inset scale-[0.995] bg-slate-900' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files); }}
      >
        {isSidebarCollapsed && (
            <button 
                onClick={() => setIsSidebarCollapsed(false)}
                className="absolute top-6 left-6 z-40 p-3 bg-black/40 hover:bg-black/60 backdrop-blur-xl border border-white/10 rounded-2xl text-white transition-all shadow-2xl"
            >
                <PanelLeft className="w-6 h-6" />
            </button>
        )}

        {!activeImageId ? (
          <div className="flex-1 flex flex-col items-center justify-center p-12 text-center bg-slate-950">
            <div className="w-32 h-32 bg-slate-900/50 rounded-[2.5rem] flex items-center justify-center mb-8 border border-slate-800 rotate-6 group hover:rotate-0 transition-transform duration-500 pointer-events-none">
              <ImageIcon className="w-16 h-16 text-slate-700" />
            </div>
            <h2 className="text-4xl font-black mb-4 text-white tracking-tighter">Ready to Immersive</h2>
            <p className="text-slate-500 text-base max-w-sm mb-10">Upload or drag and drop your panoramas to start the engine.</p>
            <div className="flex gap-4">
               <span className="px-4 py-2 rounded-full border border-white/5 bg-white/5 text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">Smooth LOD Sync</span>
               <span className="px-4 py-2 rounded-full border border-white/5 bg-white/5 text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">Priority Tiling</span>
            </div>
          </div>
        ) : (
          <div className="flex-1 relative">
             <div className="absolute bottom-8 right-8 z-20 pointer-events-none flex flex-col items-end gap-3">
                <div className="bg-black/40 backdrop-blur-2xl p-4 rounded-2xl border border-white/10 flex items-center gap-6 pointer-events-auto">
                  <div className="flex items-center gap-2">
                    <ZoomIn className="w-4 h-4 text-indigo-400" />
                    <span className="text-xs font-mono font-black text-white">{Math.round(zoomLevel)}°</span>
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
             <div ref={containerRef} className="w-full h-full bg-black cursor-grab active:cursor-grabbing" />
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
