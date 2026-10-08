/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** Where the backend is; without it the page uses the testbed's http://localhost:8080. */
	readonly VITE_SUBAKO_BASE_URL?: string;
}
