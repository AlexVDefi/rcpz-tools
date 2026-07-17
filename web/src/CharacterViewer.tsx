import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveBody, resolveClip, listClips } from '@shared/character-core.js';
import { THREE, makeSkinnedMaterial, CHAR_LIGHTING, makeOrbit } from './render/three-core';
import { glbToGltf, bytesToTexture } from './render/loaders';
import { normaliseClip, boneRestMap } from './render/anim';
import { RigSet } from './render/rigset';

interface Ctx { resolver: unknown; converter: unknown; }
interface Clip { id: string; name: string; actor: string; format: string; isMod: boolean; rel: string; }

interface Engine {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  orbit: ReturnType<typeof makeOrbit>;
  rigs: RigSet;
  clock: THREE.Clock;
  bodyRest: Map<string, THREE.Quaternion>;
  playing: boolean;
  speed: number;
  raf: number;
  disposed: boolean;
}

export function CharacterViewer({ ctx, index }: { ctx: Ctx; index: unknown }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [gender, setGender] = useState<'male' | 'female'>('male');
  const [status, setStatus] = useState('loading body…');
  const [nowPlaying, setNowPlaying] = useState('');
  const [playing, setPlaying] = useState(true);
  const [filter, setFilter] = useState('');

  const clips: Clip[] = useMemo(() => listClips(index), [index]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const rows = f ? clips.filter((c) => c.name.toLowerCase().includes(f)) : clips;
    return rows.slice(0, 500);
  }, [clips, filter]);

  // init three once
  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setClearColor(0x14141a, 1);
    const scene = new THREE.Scene();
    scene.add(new THREE.GridHelper(4, 16, 0x2b2b34, 0x24242c));
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    const orbit = makeOrbit(() => camera, canvas);
    const rigs = new RigSet(scene);
    const eng: Engine = { renderer, scene, camera, orbit, rigs, clock: new THREE.Clock(), bodyRest: new Map(), playing: true, speed: 1, raf: 0, disposed: false };
    engineRef.current = eng;

    const fit = () => {
      const wrap = canvas.parentElement!;
      const w = wrap.clientWidth, h = wrap.clientHeight;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      orbit.apply();
    };
    fit();
    window.addEventListener('resize', fit);

    const loop = () => {
      if (eng.disposed) return;
      eng.raf = requestAnimationFrame(loop);
      const dt = eng.clock.getDelta();
      if (eng.rigs.clip && eng.playing) eng.rigs.update(dt * eng.speed);
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      eng.disposed = true;
      cancelAnimationFrame(eng.raf);
      window.removeEventListener('resize', fit);
      orbit.dispose();
      renderer.dispose();
    };
  }, []);

  // load / swap body when gender changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const eng = engineRef.current; if (!eng) return;
      setStatus('loading body…');
      try {
        const body = await resolveBody(ctx, { gender });
        if (cancelled || eng.disposed) return;
        const gltf = await glbToGltf(body.meshGlb);
        const tex = await bytesToTexture(body.skinTexture, false);
        const root = gltf.scene;
        const mat = makeSkinnedMaterial(tex, CHAR_LIGHTING);
        root.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) {
            if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
            mesh.material = mat; mesh.frustumCulled = false;
          }
        });
        eng.bodyRest = boneRestMap(root);
        const hadBody = !!eng.rigs.bodyRig();
        eng.rigs.removeKind('body');
        eng.rigs.add('body', root);
        root.updateMatrixWorld(true);
        if (!hadBody) {
          const box = new THREE.Box3().setFromObject(root);
          const c = box.getCenter(new THREE.Vector3());
          const s = box.getSize(new THREE.Vector3());
          eng.orbit.setTarget(new THREE.Vector3(0, c.y, 0));
          eng.orbit.state.radius = Math.max(s.y, 1) * 1.9;
          eng.orbit.apply();
        }
        setStatus('');
      } catch (e) {
        if (!cancelled) setStatus('body error: ' + (e instanceof Error ? e.message : String(e)));
      }
    })();
    return () => { cancelled = true; };
  }, [ctx, gender]);

  async function play(clip: Clip) {
    const eng = engineRef.current; if (!eng) return;
    setNowPlaying('loading ' + clip.name + '…');
    try {
      const r = await resolveClip(ctx, clip);
      if (r.error) throw new Error(r.error);
      const gltf = await glbToGltf(r.glb);
      if (!gltf.animations?.length) throw new Error('no animation in ' + clip.name);
      const norm = normaliseClip(gltf.animations[0], clip.format, { clipRest: boneRestMap(gltf.scene), bodyRest: eng.bodyRest });
      eng.rigs.setLoop(true);
      eng.rigs.setClip(norm);
      eng.playing = true; setPlaying(true);
      const tag = norm.best ? '' : (clip.format === 'fbx' ? ' (fbx, best-effort)' : ` (${clip.format}, retargeted)`);
      setNowPlaying(clip.name + tag);
    } catch (e) {
      setNowPlaying('error: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  function togglePlay() {
    const eng = engineRef.current; if (!eng) return;
    eng.playing = !eng.playing; setPlaying(eng.playing);
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 12, height: 'calc(100vh - 160px)', minHeight: 420 }}>
      <div style={{ position: 'relative', background: '#14141a', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        <div style={{ position: 'absolute', left: 12, top: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
            {(['male', 'female'] as const).map((g) => (
              <button key={g} className="secondary" onClick={() => setGender(g)}
                style={{ borderRadius: 0, background: gender === g ? 'var(--accent)' : 'var(--panel)', color: gender === g ? '#fff' : 'var(--text)' }}>
                {g}
              </button>
            ))}
          </div>
          {status && <span style={{ color: 'var(--muted)', background: '#00000088', padding: '4px 8px', borderRadius: 6 }}>{status}</span>}
        </div>
        <div style={{ position: 'absolute', left: 12, bottom: 12, right: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="secondary" onClick={togglePlay}>{playing ? '❚❚' : '▶'}</button>
          <span style={{ color: 'var(--muted)', background: '#00000088', padding: '4px 8px', borderRadius: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {nowPlaying || 'pick a clip →'}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8 }}>
        <div style={{ padding: 8, borderBottom: '1px solid var(--line)' }}>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Search ${clips.length} clips…`}
            style={{ width: '100%', background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '7px 9px' }} />
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          {shown.map((c) => (
            <div key={c.id} onClick={() => play(c)}
              style={{ padding: '4px 10px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, display: 'flex', gap: 8 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#ffffff10')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
              <span style={{ color: c.isMod ? '#8ec77f' : 'var(--muted)', width: 44 }}>{c.actor}</span>
              <span>{c.name}</span>
            </div>
          ))}
          {clips.length > shown.length && <div style={{ padding: 10, color: 'var(--muted)' }}>+{clips.length - shown.length} more — refine search</div>}
        </div>
      </div>
    </div>
  );
}
