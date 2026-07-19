// Browser MeshConverter: the shared assimp-WASM converter wired to the Vite-served
// .wasm asset. Single-threaded assimpjs needs no COOP/COEP. (Runs on the main thread
// for now; moving conversions into a Web Worker is a later optimisation - the results
// are cached, so it's a cold-path cost.)
import { createMeshConverter } from '@shared/mesh-converter.js';
// Vite emits the wasm as an asset and gives us its URL.
import wasmUrl from 'assimpjs/dist/assimpjs.wasm?url';

export const converter = createMeshConverter({
  locateFile: (name: string) => (name.endsWith('.wasm') ? wasmUrl : name),
});
