import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Occupancy, TwinModel } from '@wms3d/contracts';
import { aisleAxis, deriveSide, pickFaceLine } from '@wms3d/domain';
import {
  binStyle,
  COLORS,
  dimColor,
  fillColor,
  hexToRgb,
  type ColorMode,
  type RGB,
} from './colors.ts';
import { BoxMerger, unitBinGeometry, unitBoxGeometry, unitFarBoxGeometry } from './geometry3d.ts';
import { distanceToBox, initialLod, nextLod, type Lod } from './lod.ts';
import { boundsOf, buildSceneData, type Box3Data, type SceneData } from './model.ts';
import { ISO_DIR, TOP_DIR, fitCameraToBox, inflateBox, type Vec3 } from './camera.ts';
import { pick, type PickResult } from './pick.ts';
import { CompactSlots, EMPTY, HIDDEN, OPAQUE, type SlotMesh } from './slots.ts';
import { buildTwinIndex, indicesOf, type TwinIndex } from './twinIndex.ts';

export type CameraPreset = 'top' | 'iso' | 'aisle';

export interface TwinStats {
  calls: number;
  triangles: number;
  chunks: { near: number; mid: number; far: number; culled: number; total: number };
  instances: { opaque: number; empty: number; far: number; highlight: number };
  /** 首帧（有模型）时刻，performance.now() 毫秒 */
  firstFrameAt: number | null;
  pixelRatio: number;
  degraded: boolean;
}

export interface PerfReport {
  p50Ms: number;
  samples: number;
  /** 已自动降级（dpr=1、关文字） */
  degraded: boolean;
  /** 降级后仍慢，建议切 2D */
  suggest2D: boolean;
}

export interface LocationInfo {
  locationId: string;
  code: string;
  twinIndex: number;
  qty: number | null;
  skuCount: number | null;
  fill: number | null;
  effectiveMax: number | null;
  isActive: boolean | null;
}

export interface EngineOptions {
  antialias?: boolean;
  maxPixelRatio?: number;
  /** 启动 2s 连续渲染基准（06 §7），默认 true */
  startupBenchmark?: boolean;
  /**
   * 仓位总数不超过该值时不启用远景 LOD（默认 8000）。06 §8：5k 全近景 ≈ 77k 三角形已在预算内，
   * 远景只为 20k 档降三角形；小仓总览若也切远景会丢掉仓位着色。
   */
  farLodMinBins?: number;
  /** 显示仓位编码文字（troika；近景 ≤50 个） */
  labels?: boolean;
  labelFont?: string;
  onPick?: (locationId: string) => void;
  onPickRack?: (rackKey: string) => void;
  onPickNothing?: () => void;
  onDoublePick?: (locationId: string) => void;
  onPerf?: (r: PerfReport) => void;
  /** occupancy.layoutVersion 与模型不一致（调用方应重载 TwinModel） */
  onStaleOccupancy?: (occupancyLayoutVersion: number) => void;
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

interface ChunkRt {
  group: THREE.Group;
  frameNear: THREE.Mesh | null;
  meshes: [THREE.InstancedMesh, THREE.InstancedMesh];
  slots: CompactSlots;
  lod: Lod;
  dirty: [[number, number], [number, number]];
}

const HIGHLIGHT_MAX = 200;
const MARKER_MAX = 50;
const PULSE_MS = 8000;

function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class TwinEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private readonly container: HTMLElement;
  private readonly opts: EngineOptions;
  private model: TwinModel | null = null;
  private data: SceneData | null = null;
  private index: TwinIndex | null = null;
  private occ: Occupancy | null = null;
  private mode: ColorMode = 'occupancy';
  private highlight = new Set<number>();
  private maxLevel: number | undefined;
  private root = new THREE.Group();
  private chunks: ChunkRt[] = [];
  private far: THREE.InstancedMesh | null = null;
  private farRacks: number[] = [];
  private hl: THREE.InstancedMesh | null = null;
  private markers: THREE.InstancedMesh | null = null;
  private zoneRgb = new Map<string, RGB>();
  private needsRender = true;
  private raf = 0;
  private disposed = false;
  private lost = false;
  private flight: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    tFrom: THREE.Vector3;
    tTo: THREE.Vector3;
    start: number;
    dur: number;
  } | null = null;
  private pulseUntil = 0;
  private firstFrameAt: number | null = null;
  private bench: { until: number; times: number[]; last: number; phase: 1 | 2 } | null = null;
  private degraded = false;
  private ro: ResizeObserver | null = null;
  private down: { x: number; y: number; t: number } | null = null;
  private lastPreset: CameraPreset = 'iso';
  private cameraPlaced = false;
  /** 用户未手动旋转/缩放过：resize 时重新套用机位 */
  private autoFit = true;
  private labelLayer: import('./labels.ts').LabelLayer | null = null;

  constructor(container: HTMLElement, opts: EngineOptions = {}) {
    this.container = container;
    this.opts = opts;
    this.renderer = new THREE.WebGLRenderer({
      antialias: opts.antialias ?? true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio ?? 2));
    this.renderer.setClearColor(0xeef1f5, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000);
    this.camera.position.set(30, 40, 60);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.controls.addEventListener('change', this.onControlsChange);
    this.controls.addEventListener('start', this.onControlsStart);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x5c6570, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 2.25);
    sun.position.set(0.85, 1.5, 0.55);
    this.scene.add(sun);
    this.scene.add(this.root);
    canvas.addEventListener('webglcontextlost', this.onLost, false);
    canvas.addEventListener('webglcontextrestored', this.onRestored, false);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('dblclick', this.onDblClick);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    if (opts.labels) void this.initLabels();
    this.loop();
  }

  // ---------------- 公共接口 ----------------

  setModel(model: TwinModel): void {
    const ids = this.index ? [...this.highlight].map((k) => this.index!.indexToId[k]!) : [];
    this.model = model;
    this.index = buildTwinIndex(model);
    this.data = buildSceneData(model);
    this.zoneRgb = new Map(
      model.layout.zones.map((z) => [
        z.code,
        z.color ? dimColor(hexToRgb(z.color), 0.35) : COLORS.neutral,
      ]),
    );
    // 版本变化时 twinIndex 失效：高亮按 locationId 重新映射；occupancy 必须重新拉（同版本才保留）
    if (this.occ && this.occ.layoutVersion !== model.layoutVersion) this.occ = null;
    this.highlight = new Set(indicesOf(this.index, ids));
    this.buildScene();
    if (!this.cameraPlaced) {
      this.cameraPlaced = true;
      this.setCameraPreset(this.lastPreset, false);
    }
    this.requestRender();
  }

  getModel(): TwinModel | null {
    return this.model;
  }
  getIndex(): TwinIndex | null {
    return this.index;
  }
  getSceneData(): SceneData | null {
    return this.data;
  }

  setOccupancy(occ: Occupancy | null): void {
    if (
      occ &&
      this.data &&
      (occ.layoutVersion !== this.data.layoutVersion || occ.qty.length !== this.data.n)
    ) {
      this.opts.onStaleOccupancy?.(occ.layoutVersion);
      occ = null;
    }
    const prev = this.occ;
    this.occ = occ;
    if (!this.data) return;
    if (prev && occ) {
      // 只更新变化的仓位（06 §6）
      const changed: number[] = [];
      for (let k = 0; k < this.data.n; k++)
        if (
          prev.qty[k] !== occ.qty[k] ||
          prev.skuCount[k] !== occ.skuCount[k] ||
          prev.fill[k] !== occ.fill[k] ||
          prev.isActive[k] !== occ.isActive[k]
        )
          changed.push(k);
      if (changed.length === 0) return;
      this.applyStyles(changed);
    } else this.applyStyles(null);
  }

  setColorMode(mode: ColorMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.applyStyles(null);
  }

  /** 只看第 N 层及以下（undefined = 全部）。紧凑数组 + count 实现（06 §4）。 */
  setMaxLevel(n: number | undefined): void {
    if (n === this.maxLevel) return;
    this.maxLevel = n;
    this.applyStyles(null);
  }

  /** 高亮一组 locationId（≤200 个进入脉冲 mesh，≤50 个立光柱）；其余混灰。 */
  setHighlight(ids: readonly string[], fly = true): void {
    if (!this.index) return;
    const next = new Set(indicesOf(this.index, ids));
    const same = next.size === this.highlight.size && [...next].every((k) => this.highlight.has(k));
    if (same) return;
    this.highlight = next;
    this.applyStyles(null);
    if (fly && next.size) this.flyToIndices([...next]);
  }

  flyToLocations(ids: readonly string[]): void {
    if (this.index) this.flyToIndices(indicesOf(this.index, ids));
  }

  flyToIndices(indices: readonly number[], durMs = 700): void {
    if (!this.data) return;
    const racks = new Set<number>();
    const extra: number[] = [];
    for (const k of indices) {
      extra.push(k);
      const ri = this.data.locRack[k]!;
      if (ri >= 0) racks.add(ri);
    }
    for (const ri of racks) extra.push(...this.data.racks[ri]!.locs);
    const b = boundsOf(this.data, extra);
    if (b) this.flyToBox(inflateBox(b, 1.2), durMs);
  }

  setCameraPreset(p: CameraPreset, animate = true): void {
    this.lastPreset = p;
    this.autoFit = true;
    if (!this.data) return;
    let pos: THREE.Vector3;
    let target: THREE.Vector3;
    if (p === 'aisle') {
      const a = this.aisleView();
      pos = a.pos;
      target = a.target;
    } else {
      const fitted = fitCameraToBox(
        this.data.bounds,
        Math.max(this.camera.aspect, 0.05),
        this.camera.fov,
        p === 'top' ? TOP_DIR : ISO_DIR,
        1.22,
      );
      pos = new THREE.Vector3(...fitted.pos);
      target = new THREE.Vector3(...fitted.target);
    }
    if (animate) this.flyTo(pos, target, 700);
    else {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.requestRender();
    }
  }

  /** 选中卡片用的数据。 */
  info(locationId: string): LocationInfo | null {
    const k = this.index?.idToIndex.get(locationId);
    if (k === undefined || !this.model) return null;
    const o = this.occ;
    return {
      locationId,
      code: this.model.locations.code[k]!,
      twinIndex: k,
      qty: o ? o.qty[k]! : null,
      skuCount: o ? o.skuCount[k]! : null,
      fill: o ? o.fill[k]! : null,
      effectiveMax: o ? o.effectiveMax[k]! : null,
      isActive: o ? o.isActive[k] === 1 : null,
    };
  }

  /** 仓位在屏幕上的像素坐标（选中卡片定位用）；不在视野内返回 null。 */
  screenPosOf(locationId: string): { x: number; y: number } | null {
    const k = this.index?.idToIndex.get(locationId);
    if (k === undefined || !this.data) return null;
    const v = new THREE.Vector3(
      this.data.centers[3 * k],
      this.data.centers[3 * k + 1],
      this.data.centers[3 * k + 2],
    );
    v.project(this.camera);
    if (v.z > 1) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height };
  }

  /** 屏幕坐标拾取（客户端坐标）。 */
  pickAt(clientX: number, clientY: number): PickResult | null {
    if (!this.data) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const o = rc.ray.origin;
    const d = rc.ray.direction;
    return pick(this.data, [o.x, o.y, o.z], [d.x, d.y, d.z], {
      maxLevel: this.maxLevel,
      isFar: (c) => this.chunks[c]?.lod === 'far',
    });
  }

  /** 强制渲染一帧并返回统计（基准用）。 */
  renderNow(): TwinStats {
    this.renderFrame(performance.now());
    return this.stats();
  }

  stats(): TwinStats {
    const info = this.renderer.info.render;
    const c = { near: 0, mid: 0, far: 0, culled: 0, total: this.chunks.length };
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(
        this.camera.projectionMatrix,
        this.camera.matrixWorldInverse,
      ),
    );
    const box = new THREE.Box3();
    this.chunks.forEach((ch, i) => {
      const b = this.data!.chunks[i]!.bbox;
      box.min.fromArray(b.min);
      box.max.fromArray(b.max);
      if (!frustum.intersectsBox(box)) c.culled++;
      else c[ch.lod]++;
    });
    let opaque = 0;
    let empty = 0;
    for (const ch of this.chunks) {
      opaque += ch.slots.count[0];
      empty += ch.slots.count[1];
    }
    return {
      calls: info.calls,
      triangles: info.triangles,
      chunks: c,
      instances: { opaque, empty, far: this.far?.count ?? 0, highlight: this.hl?.count ?? 0 },
      firstFrameAt: this.firstFrameAt,
      pixelRatio: this.renderer.getPixelRatio(),
      degraded: this.degraded,
    };
  }

  /** 上下文恢复后重建几何/材质/实例缓冲（06 §7）。 */
  rebuild(): void {
    if (!this.model) return;
    const occ = this.occ;
    const m = this.model;
    this.model = null;
    this.setModel(m);
    this.occ = null;
    this.setOccupancy(occ);
  }

  requestRender(): void {
    this.needsRender = true;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onLost);
    canvas.removeEventListener('webglcontextrestored', this.onRestored);
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('dblclick', this.onDblClick);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.controls.dispose();
    this.clearScene();
    this.labelLayer?.dispose();
    this.renderer.dispose();
    canvas.remove();
  }

  // ---------------- 场景构建 ----------------

  private clearScene(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.root.clear();
    this.chunks = [];
    this.far = null;
    this.hl = null;
    this.markers = null;
  }

  private buildScene(): void {
    this.clearScene();
    const data = this.data!;
    const model = this.model!;
    const { widthM, depthM } = model.layout.warehouse;
    // 地面 + 网格（2 draw calls）
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(widthM, depthM),
      new THREE.MeshLambertMaterial({ color: 0xf7f8fa }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(widthM / 2, 0, depthM / 2);
    floor.name = 'floor';
    this.root.add(floor);
    const gl: number[] = [];
    const step = Math.max(1, Math.round(Math.max(widthM, depthM) / 60)) * 2;
    for (let x = 0; x <= widthM + 1e-6; x += step) gl.push(x, 0.003, 0, x, 0.003, depthM);
    for (let z = 0; z <= depthM + 1e-6; z += step) gl.push(0, 0.003, z, widthM, 0.003, z);
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(gl, 3)),
      new THREE.LineBasicMaterial({ color: 0xd5dae1 }),
    );
    grid.name = 'grid';
    this.root.add(grid);
    // 库区合并为 1 个顶点色几何（1 draw call）
    const zp: number[] = [];
    const zc: number[] = [];
    for (const z of model.layout.zones) {
      const contour = z.polygon.map(([x, y]) => new THREE.Vector2(x, y));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      const rgb = z.color ? hexToRgb(z.color) : COLORS.neutral;
      const col = [0.78 + rgb[0] * 0.22, 0.78 + rgb[1] * 0.22, 0.78 + rgb[2] * 0.22];
      for (const t of tris)
        for (const v of t) {
          const p = z.polygon[v]!;
          zp.push(p[0], 0.006, p[1]);
          zc.push(...col);
        }
    }
    if (zp.length) {
      const zg = new THREE.BufferGeometry();
      zg.setAttribute('position', new THREE.Float32BufferAttribute(zp, 3));
      zg.setAttribute('color', new THREE.Float32BufferAttribute(zc, 3));
      const zones = new THREE.Mesh(
        zg,
        new THREE.MeshBasicMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -1,
        }),
      );
      zones.name = 'zones';
      this.root.add(zones);
    }
    // 分块
    const binGeo = unitBinGeometry();
    const opaqueMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const emptyMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      depthWrite: true,
    });
    const frameMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(...COLORS.frame) });
    const sphere = new THREE.Sphere();
    const box = new THREE.Box3();
    for (const cg of data.chunks) {
      const group = new THREE.Group();
      group.name = `chunk:${cg.key}`;
      box.min.fromArray(cg.bbox.min);
      box.max.fromArray(cg.bbox.max);
      box.getBoundingSphere(sphere);
      let frameNear: THREE.Mesh | null = null;
      if (cg.racks.length) {
        const merger = new BoxMerger();
        for (const ri of cg.racks) merger.addRackFrame(data.racks[ri]!);
        frameNear = new THREE.Mesh(merger.build(), frameMat);
        frameNear.name = 'frameNear';
        group.add(frameNear);
      }
      const N = Math.max(1, cg.locs.length);
      const mk = (mat: THREE.Material, name: string) => {
        const m = new THREE.InstancedMesh(binGeo, mat, N);
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
        m.instanceColor.setUsage(THREE.DynamicDrawUsage);
        m.count = 0;
        m.visible = false;
        m.boundingSphere = sphere.clone();
        m.boundingBox = box.clone();
        m.name = name;
        group.add(m);
        return m;
      };
      const opaque = mk(opaqueMat, 'binsOpaque');
      const empty = mk(emptyMat, 'binsEmpty');
      empty.renderOrder = 1;
      this.root.add(group);
      this.chunks.push({
        group,
        frameNear,
        meshes: [opaque, empty],
        slots: new CompactSlots(cg.locs.length),
        lod: 'mid',
        dirty: [
          [Infinity, -Infinity],
          [Infinity, -Infinity],
        ],
      });
    }
    // 远景：全部远景货架一个 InstancedMesh（M-N13；块数 > 30 时自然合批）
    if (data.racks.length) {
      const far = new THREE.InstancedMesh(
        unitFarBoxGeometry(),
        new THREE.MeshLambertMaterial({ color: 0xffffff }),
        data.racks.length,
      );
      far.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(data.racks.length * 3),
        3,
      );
      far.count = 0;
      far.visible = false;
      far.name = 'frameFar';
      far.frustumCulled = false;
      this.far = far;
      this.root.add(far);
    }
    // 高亮脉冲框 + 光柱
    const hl = new THREE.InstancedMesh(
      unitBoxGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0xff4d4f,
        transparent: true,
        opacity: 0.85,
        depthTest: true,
      }),
      HIGHLIGHT_MAX,
    );
    hl.count = 0;
    hl.visible = false;
    hl.frustumCulled = false;
    hl.renderOrder = 2;
    hl.name = 'highlight';
    this.hl = hl;
    this.root.add(hl);
    const beam = new THREE.CylinderGeometry(0.12, 0.12, 1, 8, 1, true);
    beam.translate(0, 0.5, 0);
    const markers = new THREE.InstancedMesh(
      beam,
      new THREE.MeshBasicMaterial({
        color: 0xff4d4f,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
      MARKER_MAX,
    );
    markers.count = 0;
    markers.visible = false;
    markers.frustumCulled = false;
    markers.renderOrder = 3;
    markers.name = 'markers';
    this.markers = markers;
    this.root.add(markers);
    this.updateLods(true);
    this.applyStyles(null);
  }

  // ---------------- 着色 / 槽位 ----------------

  private zoneColorOf(k: number): RGB | null {
    const ri = this.data!.locRack[k]!;
    const zone =
      ri >= 0
        ? this.data!.racks[ri]!.rack.zone
        : this.data!.floors.find((f) => f.twinIndex === k)?.zone;
    return zone ? (this.zoneRgb.get(zone) ?? null) : null;
  }

  /** indices = null 表示全量。 */
  private applyStyles(indices: readonly number[] | null): void {
    const data = this.data;
    if (!data) return;
    const dim = this.highlight.size > 0;
    const occ = this.occ;
    const writeSlot = (ci: number, mesh: 0 | 1, slot: number, local: number, color: RGB | null) => {
      const ch = this.chunks[ci]!;
      const k = data.chunks[ci]!.locs[local]!;
      const m = ch.meshes[mesh];
      (m.instanceMatrix.array as Float32Array).set(
        data.matrices.subarray(16 * k, 16 * k + 16),
        16 * slot,
      );
      if (color) (m.instanceColor!.array as Float32Array).set(color, 3 * slot);
      const d = ch.dirty[mesh];
      if (slot < d[0]) d[0] = slot;
      if (slot > d[1]) d[1] = slot;
    };
    const one = (k: number) => {
      const ci = data.locChunk[k]!;
      if (ci < 0) return;
      const ch = this.chunks[ci]!;
      const local = data.locLocal[k]!;
      const st = binStyle(this.mode, occ, k, this.zoneColorOf(k));
      let color = st.color;
      if (dim && !this.highlight.has(k)) color = dimColor(color);
      const lvl = data.locLevel[k]!;
      const target: SlotMesh =
        this.maxLevel !== undefined && lvl > this.maxLevel ? HIDDEN : st.mesh;
      let colorWritten = false;
      ch.slots.assign(local, target, (w) => {
        const kk = data.chunks[ci]!.locs[w.local]!;
        if (kk === k) colorWritten = true;
        writeSlot(ci, w.mesh, w.slot, w.local, kk === k ? color : this.colorAt(ch, w.mesh));
      });
      if (!colorWritten && target !== HIDDEN) {
        const slot = ch.slots.slotOf[local]!;
        writeSlot(ci, target as 0 | 1, slot, local, color);
      }
    };
    if (indices) for (const k of indices) one(k);
    else for (let k = 0; k < data.n; k++) one(k);
    this.flushChunks();
    this.updateFarColors();
    this.updateHighlightMeshes();
    this.labelLayer?.invalidate();
    this.requestRender();
  }

  /** swap-remove 搬动时保留原槽位颜色（移动前该槽位的颜色已在缓冲中——搬动的是末尾实例，读取它旧槽位的颜色）。 */
  private colorAt(ch: ChunkRt, mesh: 0 | 1): RGB {
    // 被搬动的实例来自末尾 count（已减 1 后的 count 位置）
    const arr = ch.meshes[mesh].instanceColor!.array as Float32Array;
    const from = ch.slots.count[mesh];
    return [arr[3 * from]!, arr[3 * from + 1]!, arr[3 * from + 2]!];
  }

  private flushChunks(): void {
    for (const ch of this.chunks) {
      for (const mi of [0, 1] as const) {
        const m = ch.meshes[mi];
        m.count = ch.slots.count[mi];
        m.visible = m.count > 0 && ch.lod !== 'far';
        const d = ch.dirty[mi];
        if (d[0] <= d[1]) {
          m.instanceMatrix.clearUpdateRanges();
          m.instanceMatrix.addUpdateRange(d[0] * 16, (d[1] - d[0] + 1) * 16);
          m.instanceMatrix.needsUpdate = true;
          m.instanceColor!.clearUpdateRanges();
          m.instanceColor!.addUpdateRange(d[0] * 3, (d[1] - d[0] + 1) * 3);
          m.instanceColor!.needsUpdate = true;
          ch.dirty[mi] = [Infinity, -Infinity];
        }
      }
    }
  }

  /** 远景货架汇总色：有货比例 → 绿黄橙；全空 → 浅灰；全停用 → 暗红；含高亮 → 红。 */
  private rackColor(ri: number): RGB {
    const r = this.data!.racks[ri]!;
    const occ = this.occ;
    if (this.highlight.size) {
      for (const k of r.locs) if (this.highlight.has(k)) return COLORS.highlight;
    }
    let base: RGB;
    if (!occ || this.mode === 'zone') base = this.zoneRgb.get(r.rack.zone) ?? COLORS.neutral;
    else {
      let used = 0;
      let active = 0;
      for (const k of r.locs) {
        if (occ.isActive[k] === 0) continue;
        active++;
        if ((occ.qty[k] ?? 0) > 0) used++;
      }
      base = active === 0 ? COLORS.inactive : used === 0 ? COLORS.empty : fillColor(used / active);
    }
    return this.highlight.size ? dimColor(base) : base;
  }

  private updateFarColors(): void {
    const far = this.far;
    if (!far) return;
    const arr = far.instanceColor!.array as Float32Array;
    this.farRacks.forEach((ri, slot) => arr.set(this.rackColor(ri), 3 * slot));
    far.instanceColor!.needsUpdate = true;
  }

  private rebuildFar(): void {
    const far = this.far;
    const data = this.data;
    if (!far || !data) return;
    this.farRacks = [];
    const m = far.instanceMatrix.array as Float32Array;
    const tmp = new Float32Array(16);
    for (const r of data.racks) {
      if (this.chunks[r.chunk]!.lod !== 'far') continue;
      const slot = this.farRacks.push(r.index) - 1;
      const top =
        this.maxLevel !== undefined
          ? r.levelTop[Math.min(this.maxLevel, r.type.levels) - 1]!
          : r.heightM;
      const mat = new THREE.Matrix4().compose(
        new THREE.Vector3(r.rack.x, 0, r.rack.z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.rotY),
        new THREE.Vector3(r.lengthM, top, r.type.depthM),
      );
      mat.toArray(tmp);
      m.set(tmp, 16 * slot);
    }
    far.count = this.farRacks.length;
    far.visible = far.count > 0;
    far.instanceMatrix.needsUpdate = true;
    this.updateFarColors();
  }

  private updateHighlightMeshes(): void {
    const data = this.data;
    const hl = this.hl;
    const mk = this.markers;
    if (!data || !hl || !mk) return;
    const ids = [...this.highlight].slice(0, HIGHLIGHT_MAX);
    const m = new THREE.Matrix4();
    const tmp = new Float32Array(16);
    let n = 0;
    let nm = 0;
    for (const k of ids) {
      if (data.locChunk[k]! < 0) continue;
      if (this.maxLevel !== undefined && data.locLevel[k]! > this.maxLevel) continue;
      m.fromArray(data.matrices, 16 * k);
      m.scale(new THREE.Vector3(1.12, 1.12, 1.12));
      m.toArray(tmp);
      (hl.instanceMatrix.array as Float32Array).set(tmp, 16 * n++);
      if (nm < MARKER_MAX) {
        const ri = data.locRack[k]!;
        const base = ri >= 0 ? data.racks[ri]!.heightM : 0.1;
        const cx = data.centers[3 * k]!;
        const cz = data.centers[3 * k + 2]!;
        m.compose(
          new THREE.Vector3(cx, base + 0.1, cz),
          new THREE.Quaternion(),
          new THREE.Vector3(1, 4, 1),
        );
        m.toArray(tmp);
        (mk.instanceMatrix.array as Float32Array).set(tmp, 16 * nm++);
      }
    }
    hl.count = n;
    hl.visible = n > 0;
    hl.instanceMatrix.needsUpdate = true;
    mk.count = nm;
    mk.visible = nm > 0;
    mk.instanceMatrix.needsUpdate = true;
    if (n > 0) this.pulseUntil = performance.now() + PULSE_MS;
  }

  // ---------------- LOD ----------------

  private updateLods(force = false): boolean {
    const data = this.data;
    if (!data) return false;
    const p: [number, number, number] = [
      this.camera.position.x,
      this.camera.position.y,
      this.camera.position.z,
    ];
    let changed = false;
    data.chunks.forEach((cg, i) => {
      const ch = this.chunks[i]!;
      const dist = distanceToBox(p, cg.bbox);
      let lod = force ? initialLod(dist) : nextLod(ch.lod, dist);
      if (lod === 'far' && (cg.kind === 'floor' || data.n <= (this.opts.farLodMinBins ?? 8000)))
        lod = 'mid';
      if (lod !== ch.lod || force) {
        changed ||= lod !== ch.lod;
        ch.lod = lod;
        const vis = lod !== 'far';
        if (ch.frameNear) ch.frameNear.visible = vis;
        for (const m of ch.meshes) m.visible = vis && m.count > 0;
      }
    });
    if (changed || force) {
      this.rebuildFar();
      this.labelLayer?.invalidate();
    }
    return changed;
  }

  // ---------------- 相机 ----------------

  private aisleView(): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const data = this.data!;
    // 优先高亮所在巷道，否则第一条巷道
    let ci = data.chunks.findIndex((c) => c.kind === 'aisle');
    const h = [...this.highlight][0];
    if (
      h !== undefined &&
      data.locChunk[h]! >= 0 &&
      data.chunks[data.locChunk[h]!]!.kind === 'aisle'
    )
      ci = data.locChunk[h]!;
    if (ci < 0) return { pos: this.camera.position.clone(), target: this.controls.target.clone() };
    const cg = data.chunks[ci]!;
    const racks = cg.racks.map((r) => data.racks[r]!);
    const axis = aisleAxis(racks[0]!.rack.rotationDeg);
    const lines = (side: 'L' | 'R') =>
      racks.filter((r) => deriveSide(r.rack.rotationDeg) === side).map((r) => pickFaceLine(r.rack));
    const L = lines('L');
    const R = lines('R');
    // 取货面：水平巷道 L(0°) 货架在面线 −z 侧，R(180°) 在 +z 侧；竖直巷道 L(90°) 在 +x 侧，R(270°) 在 −x 侧
    let mid: number;
    if (L.length && R.length) mid = (L[0]! + R[0]!) / 2;
    else if (L.length) mid = L[0]! + (axis === 'x' ? 1.5 : -1.5);
    else mid = R[0]! + (axis === 'x' ? -1.5 : 1.5);
    const b = cg.bbox;
    if (axis === 'x') {
      return {
        pos: new THREE.Vector3(b.min[0] - 3, 1.7, mid),
        target: new THREE.Vector3(b.max[0], 1.4, mid),
      };
    }
    return {
      pos: new THREE.Vector3(mid, 1.7, b.min[2] - 3),
      target: new THREE.Vector3(mid, 1.4, b.max[2]),
    };
  }

  private flyToBox(b: Box3Data, durMs: number): void {
    this.autoFit = false;
    let dir: Vec3 = ISO_DIR;
    const cur = this.camera.position.clone().sub(this.controls.target);
    if (cur.lengthSq() > 1e-6) {
      cur.normalize();
      const elev = Math.asin(THREE.MathUtils.clamp(cur.y, -1, 1));
      const e = THREE.MathUtils.clamp(
        elev,
        THREE.MathUtils.degToRad(28),
        THREE.MathUtils.degToRad(60),
      );
      const horiz = new THREE.Vector3(cur.x, 0, cur.z);
      if (horiz.lengthSq() < 1e-6) horiz.set(ISO_DIR[0], 0, ISO_DIR[2]);
      horiz.normalize().multiplyScalar(Math.cos(e));
      dir = [horiz.x, Math.sin(e), horiz.z];
    }
    const fitted = fitCameraToBox(
      b,
      Math.max(this.camera.aspect, 0.05),
      this.camera.fov,
      dir,
      1.35,
    );
    this.flyTo(new THREE.Vector3(...fitted.pos), new THREE.Vector3(...fitted.target), durMs);
  }

  private flyTo(pos: THREE.Vector3, target: THREE.Vector3, durMs: number): void {
    this.flight = {
      from: this.camera.position.clone(),
      to: pos,
      tFrom: this.controls.target.clone(),
      tTo: target,
      start: performance.now(),
      dur: Math.max(1, durMs),
    };
    this.flightStartedAt = performance.now();
    this.requestRender();
  }

  /** 最近一次相机飞行开始时刻（performance.now()；SKU 定位 ≤1s 指标用） */
  flightStartedAt: number | null = null;

  // ---------------- 渲染循环 ----------------

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.lost || document.hidden) return;
    const now = performance.now();
    const animating = this.flight !== null || now < this.pulseUntil || this.bench !== null;
    if (!this.needsRender && !animating) return;
    this.renderFrame(now);
  };

  private renderFrame(now: number): void {
    if (this.flight) {
      const f = this.flight;
      const t = Math.min(1, (now - f.start) / f.dur);
      const k = ease(t);
      this.camera.position.lerpVectors(f.from, f.to, k);
      this.controls.target.lerpVectors(f.tFrom, f.tTo, k);
      this.controls.update();
      if (t >= 1) this.flight = null;
    }
    this.updateLods();
    if (this.hl && this.hl.count > 0) {
      const mat = this.hl.material as THREE.MeshBasicMaterial;
      mat.opacity = now < this.pulseUntil ? 0.55 + 0.35 * Math.abs(Math.sin(now / 250)) : 0.85;
    }
    this.labelLayer?.update(this);
    this.renderer.render(this.scene, this.camera);
    this.needsRender = false;
    if (this.data && this.firstFrameAt === null) this.firstFrameAt = performance.now();
    this.sampleBench(now);
  }

  /** 启动基准（06 §7）：2s 强制连续渲染，p50 帧时间 > 50ms → dpr=1、关文字；再测仍慢 → 建议 2D。 */
  startBenchmark(): void {
    const now = performance.now();
    this.bench = { until: now + 2000, times: [], last: now, phase: 1 };
  }

  private sampleBench(now: number): void {
    const b = this.bench;
    if (!b) return;
    b.times.push(now - b.last);
    b.last = now;
    if (now < b.until) return;
    const s = b.times.slice(1).sort((x, y) => x - y);
    const p50 = s.length ? s[Math.floor(s.length / 2)]! : 0;
    if (p50 > 50 && b.phase === 1) {
      this.degraded = true;
      this.renderer.setPixelRatio(1);
      this.labelLayer?.setEnabled(false);
      this.resize();
      this.opts.onPerf?.({ p50Ms: p50, samples: s.length, degraded: true, suggest2D: false });
      this.bench = { until: now + 2000, times: [], last: now, phase: 2 };
      return;
    }
    this.bench = null;
    this.opts.onPerf?.({
      p50Ms: p50,
      samples: s.length,
      degraded: this.degraded,
      suggest2D: p50 > 50,
    });
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.autoFit && this.cameraPlaced && this.data)
      this.setCameraPreset(this.lastPreset, false);
    else this.requestRender();
  }

  // ---------------- 事件 ----------------

  private onControlsChange = (): void => {
    this.requestRender();
  };

  private onControlsStart = (): void => {
    this.autoFit = false;
  };

  private onVisibility = (): void => {
    if (!document.hidden) this.requestRender();
  };

  private onLost = (e: Event): void => {
    e.preventDefault();
    this.lost = true;
    this.opts.onContextLost?.();
  };

  private onRestored = (): void => {
    this.lost = false;
    this.rebuild();
    this.opts.onContextRestored?.();
    this.requestRender();
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onPointerUp = (e: PointerEvent): void => {
    const d = this.down;
    this.down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 600)
      return;
    const r = this.pickAt(e.clientX, e.clientY);
    if (!r) this.opts.onPickNothing?.();
    else if (r.kind === 'location') this.opts.onPick?.(this.index!.indexToId[r.twinIndex]!);
    else this.opts.onPickRack?.(this.data!.racks[r.rack]!.key);
  };

  private onDblClick = (e: MouseEvent): void => {
    const r = this.pickAt(e.clientX, e.clientY);
    if (r?.kind === 'location') {
      this.flyToIndices([r.twinIndex]);
      this.opts.onDoublePick?.(this.index!.indexToId[r.twinIndex]!);
    } else if (r?.kind === 'rack') {
      this.flyToIndices(this.data!.racks[r.rack]!.locs);
    }
  };

  private async initLabels(): Promise<void> {
    try {
      const { LabelLayer } = await import('./labels.ts');
      if (this.disposed) return;
      this.labelLayer = new LabelLayer(this.scene, this.opts.labelFont);
      this.requestRender();
    } catch {
      this.labelLayer = null;
    }
  }

  // ---- 供 LabelLayer 读取 ----
  /** 近景块中离相机最近的可见仓位（≤ max 个）+ 全部高亮仓位 */
  labelCandidates(
    max: number,
  ): Array<{ k: number; code: string; x: number; y: number; z: number; rotY: number }> {
    const data = this.data;
    const model = this.model;
    if (!data || !model) return [];
    const cam = this.camera.position;
    const out: Array<{ k: number; d: number }> = [];
    this.chunks.forEach((ch, ci) => {
      if (ch.lod !== 'near') return;
      for (const k of data.chunks[ci]!.locs) {
        if (ch.slots.meshOf[data.locLocal[k]!] === HIDDEN) continue;
        const dx = data.centers[3 * k]! - cam.x;
        const dy = data.centers[3 * k + 1]! - cam.y;
        const dz = data.centers[3 * k + 2]! - cam.z;
        const ri = data.locRack[k]!;
        // 只标取货面朝向相机的仓位（取货面外法线 = 局部 +z = (−sin, cos)）
        if (ri >= 0) {
          const r = data.racks[ri]!;
          if (-r.sin * -dx + r.cos * -dz <= 0) continue;
        }
        out.push({ k, d: dx * dx + dy * dy + dz * dz });
      }
    });
    out.sort((a, b) => a.d - b.d);
    const pickK = new Set(out.slice(0, max).map((o) => o.k));
    for (const k of [...this.highlight].slice(0, max)) pickK.add(k);
    return [...pickK].slice(0, max).map((k) => {
      const ri = data.locRack[k]!;
      const r = ri >= 0 ? data.racks[ri]! : null;
      // 文字贴在仓位前面（取货面外侧 2cm）
      let x = data.centers[3 * k]!;
      let z = data.centers[3 * k + 2]!;
      if (r) {
        const off = data.halfSizes[3 * k + 2]! + 0.03;
        x += -r.sin * off; // 局部 +z（取货面外侧）在世界中的方向 = (−sin, cos)
        z += r.cos * off;
      }
      return {
        k,
        code: model.locations.code[k]!,
        x,
        y: data.centers[3 * k + 1]!,
        z,
        rotY: r?.rotY ?? 0,
      };
    });
  }

  isHighlighted(k: number): boolean {
    return this.highlight.has(k);
  }
}

export { OPAQUE, EMPTY };
