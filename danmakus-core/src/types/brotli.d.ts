declare module 'brotli/decompress.js' {
  export function decompress(input: Uint8Array, outSize?: number): Uint8Array | ArrayBuffer | ArrayBufferView;

  export default decompress;
}
