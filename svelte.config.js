import adapter from '@sveltejs/adapter-cloudflare';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		// version.name is exposed as `version` in $app/environment — auto-set to build date
		version: {
			name: new Date().toISOString().slice(0, 10)
		}
	}
};

export default config;
