// Encoded with wasm-tools 1.251.0; component source is aot-preparation-component.wat.
// start adds a trapping core start; async uses async lifts and modules/lifecycle.
// All lifecycle entry points and tool _start trap if invoked.
const encoded = {
  "sync": "AGFzbQ0AAQABfABhc20BAAAAAQ0CYAABf2AEf39/fwF/AwUEAAEAAQUDAQABBzYFBm1lbW9yeQIACGFjdGl2YXRlAAAHZXhlY3V0ZQABCmRlYWN0aXZhdGUAAgdyZWFsbG9jAAMKEQQDAAALAwAACwMAAAsDAAALAAwEbmFtZQAFBGNvZGUCBAEAAAAGQAUAAgEABm1lbW9yeQAAAQAIYWN0aXZhdGUAAAEAB2V4ZWN1dGUAAAEACmRlYWN0aXZhdGUAAAEAB3JlYWxsb2MHFQVwc2oBAAFzagFzAXNqAAFzQAAAAQgIAQAAAAEDAAQHFQFAAgdjb21tYW5kcwVpbnB1dHMAAggKAQAAAQIDAAQDBQcFAUAAAAMICAEAAAIBAwAGBSgBAQMACGFjdGl2YXRlAQAAB2V4ZWN1dGUBAQAKZGVhY3RpdmF0ZQECCywBACZtYWdoZW1pdGU6bW9kdWxlcy1zeW5jL2xpZmVjeWNsZUAwLjEuMAUAAADDAQ5jb21wb25lbnQtbmFtZQErAAAEAAhhY3RpdmF0ZQEHZXhlY3V0ZQIKZGVhY3RpdmF0ZQMHcmVhbGxvYwELAAIBAAZtZW1vcnkBCQARAQAEY29kZQEJABIBAARjb2RlASEBAwAIYWN0aXZhdGUBB2V4ZWN1dGUCCmRlYWN0aXZhdGUBMAMEAAdzdHJpbmdzAQphY3RpdmF0aW9uAglleGVjdXRpb24DDGRlYWN0aXZhdGlvbgENBQEACWxpZmVjeWNsZQ==",
  "start": "AGFzbQ0AAQABkQEAYXNtAQAAAAEQA2AAAGAAAX9gBH9/f38BfwMGBQABAgECBQMBAAEHNgUGbWVtb3J5AgAIYWN0aXZhdGUAAQdleGVjdXRlAAIKZGVhY3RpdmF0ZQADB3JlYWxsb2MABAgBAAoVBQMAAAsDAAALAwAACwMAAAsDAAALABYEbmFtZQAFBGNvZGUBCAEABXN0YXJ0AgQBAAAABkAFAAIBAAZtZW1vcnkAAAEACGFjdGl2YXRlAAABAAdleGVjdXRlAAABAApkZWFjdGl2YXRlAAABAAdyZWFsbG9jBxUFcHNqAQABc2oBcwFzagABc0AAAAEICAEAAAABAwAEBxUBQAIHY29tbWFuZHMFaW5wdXRzAAIICgEAAAECAwAEAwUHBQFAAAADCAgBAAACAQMABgUoAQEDAAhhY3RpdmF0ZQEAAAdleGVjdXRlAQEACmRlYWN0aXZhdGUBAgssAQAmbWFnaGVtaXRlOm1vZHVsZXMtc3luYy9saWZlY3ljbGVAMC4xLjAFAAAAwwEOY29tcG9uZW50LW5hbWUBKwAABAAIYWN0aXZhdGUBB2V4ZWN1dGUCCmRlYWN0aXZhdGUDB3JlYWxsb2MBCwACAQAGbWVtb3J5AQkAEQEABGNvZGUBCQASAQAEY29kZQEhAQMACGFjdGl2YXRlAQdleGVjdXRlAgpkZWFjdGl2YXRlATADBAAHc3RyaW5ncwEKYWN0aXZhdGlvbgIJZXhlY3V0aW9uAwxkZWFjdGl2YXRpb24BDQUBAAlsaWZlY3ljbGU=",
  "async": "AGFzbQ0AAQABkwEAYXNtAQAAAAEUA2AAAX9gBH9/f38Bf2ADf39/AX8DBgUAAQACAQUDAQABB0EGBm1lbW9yeQIACGFjdGl2YXRlAAAHZXhlY3V0ZQABCmRlYWN0aXZhdGUAAghjYWxsYmFjawADB3JlYWxsb2MABAoVBQMAAAsDAAALAwAACwMAAAsDAAALAAwEbmFtZQAFBGNvZGUCBAEAAAAGTQYAAgEABm1lbW9yeQAAAQAIYWN0aXZhdGUAAAEAB2V4ZWN1dGUAAAEACmRlYWN0aXZhdGUAAAEAB3JlYWxsb2MAAAEACGNhbGxiYWNrBxUFcHNqAQABc2oBcwFzagABc0MAAAEICwEAAAADAwAGBwQEBxUBQwIHY29tbWFuZHMFaW5wdXRzAAIIDQEAAAEEAwAEAwYHBAUHBQFDAAADCAsBAAACAwMABgcEBgUoAQEDAAhhY3RpdmF0ZQEAAAdleGVjdXRlAQEACmRlYWN0aXZhdGUBAgsnAQAhbWFnaGVtaXRlOm1vZHVsZXMvbGlmZWN5Y2xlQDAuMS4wBQAAAM0BDmNvbXBvbmVudC1uYW1lATUAAAUACGFjdGl2YXRlAQdleGVjdXRlAgpkZWFjdGl2YXRlAwdyZWFsbG9jBAhjYWxsYmFjawELAAIBAAZtZW1vcnkBCQARAQAEY29kZQEJABIBAARjb2RlASEBAwAIYWN0aXZhdGUBB2V4ZWN1dGUCCmRlYWN0aXZhdGUBMAMEAAdzdHJpbmdzAQphY3RpdmF0aW9uAglleGVjdXRpb24DDGRlYWN0aXZhdGlvbgENBQEACWxpZmVjeWNsZQ==",
  "tool": "AGFzbQEAAAABCAJgAABgAAF/AwMCAAEHEwIGX3N0YXJ0AAAGYW5zd2VyAAEKCgIDAAALBABBKgs=",
  "cooperative": "AGFzbQEAAAABDgNgAn9/AX9gAABgAAF/AhsBDG1hZ2hlbWl0ZV9pbwpzdGRpbl9yZWFkAAADAwIBAgUDAQABBxwDBm1lbW9yeQIABl9zdGFydAABBmFuc3dlcgACCgoCAwAACwQAQSoL",
  "badImport": "AGFzbQEAAAABBAFgAAACEwEKdW5wcm92aWRlZARjYWxsAAADAgEABwoBBl9zdGFydAABCgUBAwAACw==",
  "badStart": "AGFzbQEAAAABBQFgAX8AAwIBAAcKAQZfc3RhcnQAAAoFAQMAAAs=",
  "badCooperative": "AGFzbQEAAAABCQJgAX4BfmAAAAIbAQxtYWdoZW1pdGVfaW8Kc3RkaW5fcmVhZAAAAwIBAQUDAQABBxMCBm1lbW9yeQIABl9zdGFydAABCgUBAwAACw==",
  "missingMemory": "AGFzbQEAAAABCgJgAn9/AX9gAAACGwEMbWFnaGVtaXRlX2lvCnN0ZGluX3JlYWQAAAMCAQEHCgEGX3N0YXJ0AAEKBQEDAAAL"
} as const;
export type PreparationBinary = keyof typeof encoded;
export function preparationBytes(kind: PreparationBinary): Uint8Array {
  return Uint8Array.from(atob(encoded[kind]), (byte) => byte.charCodeAt(0));
}

// Core WAT kept beside its encoded bytes for review, not used as a runtime compiler.
export const coreSources = {
  "tool": "(module (func (export \"_start\") unreachable) (func (export \"answer\") (result i32) i32.const 42))",
  "cooperative": "(module (import \"maghemite_io\" \"stdin_read\" (func (param i32 i32) (result i32))) (memory (export \"memory\") 1) (func (export \"_start\") unreachable) (func (export \"answer\") (result i32) i32.const 42))",
  "badImport": "(module (import \"unprovided\" \"call\" (func)) (func (export \"_start\") unreachable))",
  "badStart": "(module (func (export \"_start\") (param i32) unreachable))",
  "badCooperative": "(module (import \"maghemite_io\" \"stdin_read\" (func (param i64) (result i64))) (memory (export \"memory\") 1) (func (export \"_start\") unreachable))",
  "missingMemory": "(module (import \"maghemite_io\" \"stdin_read\" (func (param i32 i32) (result i32))) (func (export \"_start\") unreachable))"
} as const;

