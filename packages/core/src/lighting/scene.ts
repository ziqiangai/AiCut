import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  ConeGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Texture,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

import type { LightingView } from "./types.js";

const SPHERE_RADIUS = 1;
/**
 * Square plane that the subject image is painted on. We deliberately
 * keep it square (W = H) and let the per-image aspect get applied via
 * `subjectMesh.scale` once the texture loads — that way landscape AND
 * portrait images fit without one of them looking stretched.
 */
const PLANE_SIDE = 1.0;
/** Default cone half-angle (radius/height ratio) when brightness = 1. */
const BEAM_RADIUS = 0.18;
/** +Y axis as a Vector3 — ConeGeometry's default apex direction. */
const CONE_UP = new Vector3(0, 1, 0);

/**
 * three.js scene wrapper for the lighting picker. ONLY file in the
 * lighting module that imports `three` — everything else stays plain
 * DOM / TypeScript so tree-shaking for users who never instantiate
 * `LightingEditor` keeps the rest of `@aicut/core/lighting` cheap.
 */
export class LightingScene {
  private renderer: WebGLRenderer;
  private scene: Scene;
  private perspectiveCam: PerspectiveCamera;
  private frontCam: OrthographicCamera;
  private activeCam: PerspectiveCamera | OrthographicCamera;
  private sphereMesh: Mesh;          // invisible — raycast target only
  private subjectMesh: Mesh;
  private subjectMat: MeshBasicMaterial;
  private dotMesh: Mesh;
  /**
   * Cone beam from the light position toward the subject. Apex at the
   * sphere-surface dot, base at a point partway toward origin. Length
   * is controlled by `setBrightness()` (0 hides it); color by
   * `setLightColor()`. The mesh is recomputed on every light-direction
   * change because the rotation depends on the direction vector.
   */
  private beamMesh: Mesh;
  /** V2 uses MeshBasicMaterial with additive blending; V3 uses a
   *  ShaderMaterial so the beam gradient (per-vertex alpha) and
   *  color (uniform) can be controlled independently. */
  private beamMat: MeshBasicMaterial | ShaderMaterial;
  /** True when v3-style solid beam is active. Controls the
   *  opacity-on-brightness formula in updateBeam (gradient texture
   *  already does most of the fade, so we don't want the formula to
   *  fight it). */
  private solidBeamMode = false;
  /** Current normalized light direction — cached so brightness changes
   *  can rebuild the beam without re-deriving the geometry. */
  private lightDir = new Vector3(0, 0, 1);
  private brightness = 0.5;
  private raycaster = new Raycaster();
  private pendingFrame = false;
  private viewMode: LightingView;
  private size = 240;
  /** Half-extent of the ortho camera — also used to map front-view
   *  NDC drags onto sphere world coordinates. Computed in ctor so the
   *  perspective and ortho framings stay in sync. */
  private orthoHalf = 1;
  private destroyed = false;

  /**
   * Caller wires this to be notified when the user moves the light
   * via pointer interaction. Returns a unit vector in scene space.
   */
  onLightDrag: ((dir: { x: number; y: number; z: number }) => void) | null =
    null;

  constructor(
    container: HTMLElement,
    view: LightingView,
    opts?: {
      /** Hide the wireframe sphere so a CSS-rendered "soap bubble"
       *  background can show through unimpeded. The invisible raycast
       *  sphere remains, so light-direction picking still works.
       *  Default false (v2 behaviour, visible wire). */
      hideWire?: boolean;
      /** Use a non-additive, more visibly tinted beam — bumps opacity
       *  so color-temperature changes actually read. Default false
       *  (v2 keeps the soft additive glow). */
      solidBeam?: boolean;
    },
  ) {
    this.viewMode = view;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(this.size, this.size, false);
    this.renderer.setClearColor(0x000000, 0); // transparent — CSS bg shows through
    const canvas = this.renderer.domElement;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    canvas.style.display = "block";
    canvas.setAttribute("data-aicut-lighting-canvas", "");
    container.appendChild(canvas);

    this.scene = new Scene();

    // Wireframe-ish sphere — render as line segments on top of an
    // invisible solid mesh that owns the raycast hits.
    this.sphereMesh = new Mesh(
      new SphereGeometry(SPHERE_RADIUS, 32, 24),
      new MeshBasicMaterial({ visible: false }),
    );
    this.scene.add(this.sphereMesh);

    if (!opts?.hideWire) {
      const wire = new LineSegments(
        new EdgesGeometry(new SphereGeometry(SPHERE_RADIUS, 16, 12)),
        new LineBasicMaterial({
          color: 0xcccccc,
          transparent: true,
          opacity: 0.55,
        }),
      );
      this.scene.add(wire);
    }

    // Subject plane — square base, per-image aspect handled via scale.
    this.subjectMat = new MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
    });
    this.subjectMesh = new Mesh(
      new PlaneGeometry(PLANE_SIDE, PLANE_SIDE),
      this.subjectMat,
    );
    this.scene.add(this.subjectMesh);

    // Light position marker — small dark sphere on the surface.
    this.dotMesh = new Mesh(
      new SphereGeometry(0.06, 16, 12),
      new MeshBasicMaterial({ color: 0x222222 }),
    );
    this.scene.add(this.dotMesh);

    // Cone beam (rebuilt on each direction/brightness change). Initial
    // material with sane defaults — apex/length/orient applied in
    // updateBeam() on first setLightDirection.
    // V3 uses a ShaderMaterial — vertex shader emits a 1→0 alpha
    // gradient along the cone's local Y (apex=1 at the light end,
    // base=0 at the subject end); fragment shader uses a color
    // uniform multiplied by a brightness-clamping factor so the
    // beam stays visible against the light sphere background AND
    // tints faithfully with the light color (color-temperature
    // slider). MeshBasicMaterial's per-fragment alpha can't be
    // driven by a uniform separately from color, hence the shader.
    // V2 keeps the additive soft-glow path for back-compat.
    if (opts?.solidBeam) {
      this.solidBeamMode = true;
      this.beamMat = new ShaderMaterial({
        uniforms: {
          uColor: { value: new Color(0xffffff) },
          uOpacity: { value: 0.85 },
        },
        vertexShader: `
          varying float vAlpha;
          void main() {
            // Cone local Y: -0.5 at base, +0.5 at apex.
            vAlpha = position.y + 0.5;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uColor;
          uniform float uOpacity;
          varying float vAlpha;
          void main() {
            // Clamp brightness so the beam reads on white bg even
            // when uColor is pure white. The 0.55 mix toward black
            // is the "darkening" — keeps the hue but cuts luminance.
            vec3 col = mix(uColor, vec3(0.0), 0.55);
            gl_FragColor = vec4(col, vAlpha * uOpacity);
          }
        `,
        transparent: true,
        depthWrite: false,
      });
    } else {
      this.beamMat = new MeshBasicMaterial({
        color: new Color(0xffffff),
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        blending: AdditiveBlending,
      });
    }
    this.beamMesh = new Mesh(new ConeGeometry(BEAM_RADIUS, 1, 24, 1, true), this.beamMat);
    this.scene.add(this.beamMesh);

    // Cameras — framed so the sphere occupies the same screen fraction
    // in both modes. Switching views must NOT make the sphere jump.
    // For a perspective camera at distance D with vertical fov θ, the
    // sphere of radius R fills (R/D) / tan(θ/2) of the half-viewport;
    // matching ortho means halfExtent = D · tan(θ/2).
    const PERSP_FOV_DEG = 36;
    const PERSP_DIST = 3.4;
    const orthoHalf =
      PERSP_DIST * Math.tan((PERSP_FOV_DEG * Math.PI) / 360);
    this.orthoHalf = orthoHalf;
    this.perspectiveCam = new PerspectiveCamera(PERSP_FOV_DEG, 1, 0.1, 100);
    // Keep the original viewpoint angle but normalise to PERSP_DIST.
    const dirVec = new Vector3(1.8, 1.1, 2.2).normalize();
    this.perspectiveCam.position.copy(dirVec.multiplyScalar(PERSP_DIST));
    this.perspectiveCam.lookAt(0, 0, 0);

    this.frontCam = new OrthographicCamera(
      -orthoHalf,
      orthoHalf,
      orthoHalf,
      -orthoHalf,
      0.1,
      100,
    );
    this.frontCam.position.set(0, 0, 5);
    this.frontCam.lookAt(0, 0, 0);

    this.activeCam = view === "front" ? this.frontCam : this.perspectiveCam;

    this.attachPointer(canvas);
    this.requestRender();
  }

  // ---- public API ----------------------------------------------------

  setSize(px: number): void {
    if (this.destroyed) return;
    this.size = Math.max(40, Math.floor(px));
    this.renderer.setSize(this.size, this.size, false);
    this.requestRender();
  }

  setView(v: LightingView): void {
    if (this.viewMode === v) return;
    this.viewMode = v;
    this.activeCam = v === "front" ? this.frontCam : this.perspectiveCam;
    this.requestRender();
  }

  setLightDirection(dir: { x: number; y: number; z: number }): void {
    const v = new Vector3(dir.x, dir.y, dir.z);
    if (v.lengthSq() === 0) return;
    v.normalize();
    this.lightDir.copy(v);
    // Place the dot ON the surface — push out by a tiny epsilon so
    // depth-test doesn't z-fight with the wireframe.
    this.dotMesh.position.copy(
      v.clone().multiplyScalar(SPHERE_RADIUS + 0.01),
    );
    this.updateBeam();
    this.requestRender();
  }

  /** 0..1 brightness — drives the cone beam length. 0 hides it. */
  setBrightness(level: number): void {
    this.brightness = Math.max(0, Math.min(1, level));
    this.updateBeam();
    this.requestRender();
  }

  /**
   * Light color — drives the beam tint. The v3 beam now uses a
   * ShaderMaterial that takes color via a uniform and applies a
   * brightness-clamping multiplier in the fragment shader so the
   * beam stays visible against the light sphere background even at
   * bright source colors. Dot color stays static (dark) so it always
   * reads as the light SOURCE marker; the visible color feedback
   * lives on the BEAM itself, matching the user's design intent.
   */
  setLightColor(hex: string): void {
    try {
      const c = new Color(hex);
      if (this.beamMat instanceof ShaderMaterial) {
        (this.beamMat.uniforms.uColor.value as Color).copy(c);
      } else {
        this.beamMat.color = c;
        this.beamMat.needsUpdate = true;
      }
      this.requestRender();
    } catch {
      // invalid hex — leave the previous color
    }
  }

  /**
   * Spin the subject plane in-place around the +Z axis. Degrees in,
   * radians stored. Pure visual — does NOT touch the scale fit math
   * applied in setSubjectImage, so the image stays correctly aspect-
   * fit at any rotation.
   *
   * Added in v3 so the new lighting picker layout can offer a
   * "rotate the image inside the sphere" knob; v2 never calls this
   * (subjectMesh.rotation.z defaults to 0 and stays put).
   */
  setSubjectRotation(degrees: number): void {
    this.subjectMesh.rotation.z = (degrees * Math.PI) / 180;
    this.requestRender();
  }

  setSubjectImage(url: string | null): void {
    if (!url) {
      this.subjectMat.map = null;
      this.subjectMat.transparent = true;
      this.subjectMat.opacity = 0;
      this.subjectMat.needsUpdate = true;
      this.requestRender();
      return;
    }
    new TextureLoader().load(url, (tex: Texture) => {
      if (this.destroyed) return;
      // Fit-within: choose scale so longer side stays PLANE_SIDE,
      // shorter side gets aspect-adjusted. Works for both landscape
      // and portrait sources without ever stretching.
      const img = tex.image as HTMLImageElement | undefined;
      if (img && img.naturalWidth && img.naturalHeight) {
        const aspect = img.naturalWidth / img.naturalHeight;
        if (aspect >= 1) {
          // Landscape — width fills, height is narrower.
          this.subjectMesh.scale.set(1, 1 / aspect, 1);
        } else {
          // Portrait — height fills, width is narrower.
          this.subjectMesh.scale.set(aspect, 1, 1);
        }
      }
      this.subjectMat.map = tex;
      this.subjectMat.opacity = 1;
      this.subjectMat.transparent = false;
      this.subjectMat.needsUpdate = true;
      this.requestRender();
    });
  }

  /**
   * Recompute the cone-beam mesh: apex pinned to the dot, base 0..1
   * of a sphere-radius toward the origin (subject). Length 0 hides
   * the beam entirely.
   */
  private updateBeam(): void {
    const len = SPHERE_RADIUS * Math.max(0.001, this.brightness);
    // Hide the beam at zero brightness; otherwise the visual still
    // shows a flat disc at the apex.
    this.beamMesh.visible = this.brightness > 0.01;
    if (!this.beamMesh.visible) return;

    // Rebuild geometry with the right length (ConeGeometry is cheap
    // and we don't ship a custom shader; re-creating per change keeps
    // the code obvious and the geometry exact).
    this.beamMesh.geometry.dispose();
    this.beamMesh.geometry = new ConeGeometry(BEAM_RADIUS, len, 24, 1, true);

    // Cone default: apex at +Y, base at -Y, centered at origin.
    // We want apex at the dot (light position) and the cone extending
    // INWARD toward origin. So:
    //   - rotate so +Y aligns with -lightDir (apex points outward...
    //     wait, apex is +Y end, base is -Y end. If we align +Y with
    //     lightDir, then apex points outward TO the light, base
    //     points inward TOWARD origin. ✓
    //   - translate so the midpoint sits at lightDir * (R - len/2),
    //     placing the apex at lightDir * R (the sphere surface).
    const q = new Quaternion().setFromUnitVectors(CONE_UP, this.lightDir);
    this.beamMesh.quaternion.copy(q);
    this.beamMesh.position.copy(
      this.lightDir.clone().multiplyScalar(SPHERE_RADIUS - len / 2),
    );
    // Fade the beam with brightness. With the gradient texture (v3)
    // the shape of the fade is already baked in, so we only need a
    // gentle overall multiplier — clamp higher to keep saturation.
    // Additive mode (v2) gets the original softer formula.
    // Brightness multiplier. V3 (ShaderMaterial) gets a higher base
    // so even dim values stay visible against white bg; V2 uses the
    // softer additive formula.
    if (this.beamMat instanceof ShaderMaterial) {
      this.beamMat.uniforms.uOpacity.value = 0.6 + 0.4 * this.brightness;
    } else {
      this.beamMat.opacity = 0.18 + 0.32 * this.brightness;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderer.dispose();
    this.sphereMesh.geometry.dispose();
    (this.sphereMesh.material as MeshBasicMaterial).dispose();
    this.subjectMesh.geometry.dispose();
    this.subjectMat.dispose();
    this.subjectMat.map?.dispose();
    this.dotMesh.geometry.dispose();
    (this.dotMesh.material as MeshBasicMaterial).dispose();
    this.beamMesh.geometry.dispose();
    // ShaderMaterial has no `.map` field; MeshBasicMaterial might
    // (the additive-glow v2 beam doesn't use one but earlier
    // texture-based attempts did, so we still guard).
    if (this.beamMat instanceof MeshBasicMaterial) {
      this.beamMat.map?.dispose();
    }
    this.beamMat.dispose();
    this.renderer.domElement.remove();
  }

  // ---- pointer interaction -------------------------------------------

  private attachPointer(canvas: HTMLCanvasElement): void {
    let dragging = false;

    const handle = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      // NDC in [-1, 1], y flipped (screen y grows down, NDC y grows up).
      const ndcX = (px / rect.width) * 2 - 1;
      const ndcY = -((py / rect.height) * 2 - 1);

      let dir: { x: number; y: number; z: number } | null = null;
      if (this.viewMode === "front") {
        // Front-view drag — sphere fills the framed area. NDC is
        // [-1, 1]; world ortho frustum is [-orthoHalf, orthoHalf].
        const wx = ndcX * this.orthoHalf;
        const wy = ndcY * this.orthoHalf;
        const r2 = wx * wx + wy * wy;
        if (r2 <= 1) {
          dir = { x: wx, y: wy, z: Math.sqrt(1 - r2) };
        } else {
          // Outside the sphere silhouette: clamp to the equator.
          const r = Math.sqrt(r2);
          dir = { x: wx / r, y: wy / r, z: 0 };
        }
      } else {
        // Perspective — raycast against the invisible sphere mesh.
        // When the ray MISSES (mouse moved past the sphere silhouette),
        // fall back to "closest point on sphere to the ray" so the
        // dot slides smoothly along the silhouette instead of locking
        // up at the last hit position.
        this.raycaster.setFromCamera(new Vector2(ndcX, ndcY), this.perspectiveCam);
        const hits = this.raycaster.intersectObject(this.sphereMesh);
        if (hits.length > 0) {
          const p = hits[0]!.point;
          dir = { x: p.x, y: p.y, z: p.z };
        } else {
          // ray.origin + t*ray.direction is closest to origin when
          // t = -ray.origin · ray.direction. Project that point onto
          // the unit sphere to get the visible silhouette point.
          const r = this.raycaster.ray;
          const t = -r.origin.dot(r.direction);
          const closest = r.origin.clone().add(
            r.direction.clone().multiplyScalar(t),
          );
          if (closest.lengthSq() > 0) {
            closest.normalize().multiplyScalar(SPHERE_RADIUS);
            dir = { x: closest.x, y: closest.y, z: closest.z };
          }
        }
      }

      if (dir) {
        // Normalise before reporting so downstream snap math is clean.
        const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
        const out = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
        this.setLightDirection(out);
        this.onLightDrag?.(out);
      }
    };

    canvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      handle(e);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (dragging) handle(e);
    });
    canvas.addEventListener("pointerup", (e) => {
      dragging = false;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // pointer might already be released — ignore.
      }
    });
    canvas.addEventListener("pointercancel", () => {
      dragging = false;
    });
  }

  // ---- render loop ----------------------------------------------------

  private requestRender(): void {
    if (this.pendingFrame || this.destroyed) return;
    this.pendingFrame = true;
    requestAnimationFrame(() => {
      this.pendingFrame = false;
      if (this.destroyed) return;
      this.renderer.render(this.scene, this.activeCam);
    });
  }
}

/**
 * 1×256 canvas texture used as the V3 solid beam's alpha gradient.
 * White opaque at the top (UV v=0 = cone apex = light end) fading to
 * white transparent at the bottom (v=1 = cone base = subject end).
 * The material's color multiplies in the light tint, so the gradient
 * is monochrome — color comes from `material.color`.
 *
 * Built once per scene in the constructor and disposed in destroy().
 * Cost is trivial (~256 bytes of GPU memory).
 */
function buildBeamGradientTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  // BLACK gradient — matches the Figma export's
  // `paint1_linear_17045_35565` exactly: `<stop/>` (black, opacity 1)
  // → offset 0.51 opacity 0.1875 → offset 1 opacity 0. Times the
  // path's fill-opacity 0.5 = the (0.5, 0.094, 0) curve below.
  //
  // Using black (not white) is what makes the beam READ on the
  // light-colored sphere bg — a white beam on a white scene is
  // invisible. The trade-off is that material.color × texelColor.rgb
  // can't tint a black texel, so color-temperature changes won't
  // visibly retint the beam; with white sphere backgrounds the
  // visibility win is worth it.
  grad.addColorStop(0.0, "rgba(0, 0, 0, 0.5)");
  grad.addColorStop(0.51, "rgba(0, 0, 0, 0.094)");
  grad.addColorStop(1.0, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1, 256);
  return new CanvasTexture(canvas);
}
