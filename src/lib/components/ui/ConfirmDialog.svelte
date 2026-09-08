<script lang="ts">
	// Replaces window.confirm(), which is unreliable (silently returns false
	// without showing a dialog) in standalone/installed PWA contexts on many
	// mobile browsers. This is a real in-DOM modal instead.

	interface Props {
		open: boolean;
		title: string;
		message: string;
		confirmLabel?: string;
		cancelLabel?: string;
		danger?: boolean;
		onconfirm: () => void;
		oncancel: () => void;
	}

	let {
		open,
		title,
		message,
		confirmLabel = 'Delete',
		cancelLabel = 'Cancel',
		danger = true,
		onconfirm,
		oncancel
	}: Props = $props();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') oncancel();
		if (e.key === 'Enter') onconfirm();
	}
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
	<div class="overlay" onclick={oncancel} role="presentation">
		<div class="dialog" onclick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
			<h3 id="confirm-title">{title}</h3>
			<p>{message}</p>
			<div class="actions">
				<button class="btn-cancel" onclick={oncancel}>{cancelLabel}</button>
				<button class={danger ? 'btn-danger' : 'btn-primary'} onclick={onconfirm}>{confirmLabel}</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 16px;
	}
	.dialog {
		background: var(--card, #16191d);
		border: 1px solid var(--border, #2a2f36);
		border-radius: 10px;
		padding: 20px;
		max-width: 360px;
		width: 100%;
		box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
	}
	h3 {
		margin: 0 0 8px;
		font-size: 16px;
		color: var(--text, #fff);
	}
	p {
		margin: 0 0 18px;
		font-size: 13px;
		color: var(--muted, #9aa4b2);
		white-space: pre-line;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	button {
		padding: 8px 14px;
		border-radius: 6px;
		border: 1px solid var(--border, #2a2f36);
		font-size: 13px;
		cursor: pointer;
	}
	.btn-cancel {
		background: transparent;
		color: var(--text, #fff);
	}
	.btn-danger {
		background: var(--red, #ff4444);
		border-color: var(--red, #ff4444);
		color: #fff;
	}
	.btn-primary {
		background: var(--accent, #00c8ff);
		border-color: var(--accent, #00c8ff);
		color: #000;
	}
</style>
