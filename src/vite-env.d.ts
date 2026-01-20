/// <reference types="vite/client" />

type ViteEnvString = string | undefined;

interface ImportMetaEnv {
  readonly VITE_GEMINI_API_KEY: ViteEnvString;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
