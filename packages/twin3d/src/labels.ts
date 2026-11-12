// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- 环境声明随源码导出给消费方（ws-d1-1 / ws-c-1）
/// <reference path="./troika.d.ts" />
import * as THREE from 'three';
import * as troika from 'troika-three-text';

/**
 * 近距离仓位编码文字（06 §2/§5，M24）：troika SDF，≤50 个，BatchedText 合批为 1 个 draw call。
 * 字体：传 labelFont（同源 URL，离线可用）；不传时 troika 会从 CDN 取默认字体——内网部署务必传。
 */
type TextObj = THREE.Mesh & {
  text: string;
  fontSize: number;
  color: number | string;
  anchorX: string | number;
  anchorY: string | number;
  font: string | null;
  outlineWidth: number | string;
  outlineColor: number | string;
  sync(cb?: () => void): void;
  dispose(): void;
};
type BatchedTextObj = THREE.Mesh & {
  addText(t: TextObj): void;
  removeText(t: TextObj): void;
  sync(cb?: () => void): void;
  dispose(): void;
};
const lib = troika as unknown as {
  Text: new () => TextObj;
  BatchedText: new () => BatchedTextObj;
};

export const LABEL_MAX = 50;

interface Source {
  labelCandidates(
    max: number,
  ): Array<{ k: number; code: string; x: number; y: number; z: number; rotY: number }>;
  isHighlighted(k: number): boolean;
  requestRender(): void;
}

export class LabelLayer {
  private batch: BatchedTextObj;
  private pool: TextObj[] = [];
  private active = new Map<number, TextObj>();
  private dirty = true;
  private enabled = true;
  private lastCam = new THREE.Vector3(Infinity, 0, 0);
  private readonly font: string | undefined;

  constructor(scene: THREE.Scene, font?: string) {
    this.font = font;
    this.batch = new lib.BatchedText();
    this.batch.name = 'labels';
    this.batch.renderOrder = 4;
    scene.add(this.batch);
  }

  invalidate(): void {
    this.dirty = true;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.batch.visible = on;
    this.dirty = true;
  }

  update(src: Source & { camera: THREE.Camera }): void {
    if (!this.enabled) return;
    const cam = src.camera.position;
    if (!this.dirty && cam.distanceToSquared(this.lastCam) < 0.25) return;
    this.dirty = false;
    this.lastCam.copy(cam);
    const want = src.labelCandidates(LABEL_MAX);
    const keep = new Set(want.map((w) => w.k));
    for (const [k, t] of this.active)
      if (!keep.has(k)) {
        this.batch.removeText(t);
        this.active.delete(k);
        this.pool.push(t);
      }
    let added = false;
    for (const w of want) {
      let t = this.active.get(w.k);
      const hl = src.isHighlighted(w.k);
      if (!t) {
        t = this.pool.pop() ?? new lib.Text();
        t.fontSize = 0.16;
        t.anchorX = 'center';
        t.anchorY = 'middle';
        t.outlineWidth = '8%';
        t.outlineColor = 0xffffff;
        if (this.font) t.font = this.font;
        this.active.set(w.k, t);
        this.batch.addText(t);
        added = true;
      }
      t.text = w.code;
      t.color = hl ? 0xcf1322 : 0x1f2937;
      t.position.set(w.x, w.y, w.z);
      t.rotation.set(0, w.rotY, 0);
    }
    if (added || want.length) this.batch.sync(() => src.requestRender());
  }

  dispose(): void {
    for (const t of [...this.active.values(), ...this.pool]) t.dispose();
    this.batch.dispose();
    this.batch.removeFromParent();
  }
}
