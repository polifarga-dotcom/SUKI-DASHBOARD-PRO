<script lang="ts">
	import '../app.css';
	import { supabase } from '$lib/supabase.js';
	import { authStore } from '$lib/stores/auth.js';
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

		return () => subscription.unsubscribe();
	});
</script>

{@render children()}
