<script lang="ts">
	import '../app.css';
	import { supabase } from '$lib/supabase.js';
	import { authStore } from '$lib/stores/auth.js';
	import { pwaInstallPrompt } from '$lib/stores/pwa.js';
	import { onMount } from 'svelte';

	let { children } = $props();

	onMount(() => {
		supabase.auth.getSession().then(({ data: { session } }) => {
			authStore.setSession(session);
		});

		const {
			data: { subscription }
		} = supabase.auth.onAuthStateChange((_event, session) => {
			authStore.setSession(session);
		});

		// Capture PWA install prompt early — must be before any user interaction
		const onInstallPrompt = (e: Event) => {
			e.preventDefault();
			pwaInstallPrompt.set(e);
		};
		window.addEventListener('beforeinstallprompt', onInstallPrompt);

		return () => {
			subscription.unsubscribe();
			window.removeEventListener('beforeinstallprompt', onInstallPrompt);
		};
	});
</script>

{@render children()}
