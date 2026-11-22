<script lang="ts">
	// PredictWind: automatischer Sync vom Mac (Dienst, per Terminal-Befehl eingerichtet) und Upload von Hand
	import { t, isDe } from '../lib/i18n.svelte';
	import { pw, loadPw, pwScan, pwDelete, pwReloadAll } from '../chart/pw.svelte';
	import Icon from './Icon.svelte';

	const st = $derived(pw.st);
	let msg = $state('');
	let upMsg = $state('');
	let busy = $state(false);
	let over = $state(false);
	let copied = $state('');

	const origin = location.origin;
	const cmd = `curl -fsSL ${origin}/pw-sync/install.sh | bash -s ${origin}`;
	const uncmd = `curl -fsSL ${origin}/pw-sync/install.sh | bash -s -- --uninstall`;
	const FDA = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
	const okName = (n: string) => /^\d{8}_\d{4}_[A-Za-z0-9]+_[A-Za-z]+_\d+km?_.*\.grb2?$/.test(n) || /^(?:PredictWind|Offshore)_Route_.*\.gpx$/i.test(n);

	$effect(() => {
		loadPw();
		const iv = setInterval(loadPw, 15e3);
		return () => clearInterval(iv);
	});

	const when = (ms: number) => new Date(ms).toLocaleString(isDe() ? 'de-DE' : 'en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
	/** Dienst gilt als aktiv, wenn er sich in den letzten 15 min gemeldet hat (er läuft alle 5 min) */
	const active = $derived(!!st?.ping && Date.now() - st.ping.at < 15 * 60e3 && !(st.error && st.error.at > st.ping.at));

	// http:// im Bordnetz ist kein „sicherer Kontext“ → navigator.clipboard fehlt; dann über ein Textfeld kopieren
	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			const ta = Object.assign(document.createElement('textarea'), { value: text });
			document.body.append(ta);
			ta.select();
			document.execCommand('copy');
			ta.remove();
		}
		copied = text;
		setTimeout(() => (copied = ''), 1500);
	}

	async function upload(list: File[]) {
		const files = list.filter((f) => okName(f.name));
		const skipped = list.length - files.length;
		if (!files.length) return (upMsg = t('No PredictWind GRIB or route files found ({n} skipped).', { n: skipped }));
		busy = true;
		let ok = 0;
		for (const [i, f] of files.entries()) {
			upMsg = t('Uploading {i} / {n} …', { i: i + 1, n: files.length });
			const r = await fetch(`/tiles/api/pw/upload/${encodeURIComponent(f.name)}`, { method: 'PUT', headers: { 'X-Sync-Host': t('SUKI app') }, body: f }).catch(() => null);
			if (r?.ok) ok++;
		}
		busy = false;
		upMsg = t('{ok} of {n} files uploaded.', { ok, n: files.length }) + (skipped ? ' ' + t('{n} other files skipped.', { n: skipped }) : '');
		await pwReloadAll();
	}
	async function refresh() {
		msg = '';
		await pwScan();
		msg = t('Folder on the Pi read again: {n} GRIB files, {r} readable.', { n: pw.st?.files ?? 0, r: pw.st?.readable ?? 0 });
	}
	async function removeAll() {
		if (!confirm(t('Delete all PredictWind GRIB files on the Pi? Routes stay.'))) return;
		msg = t('{n} files deleted.', { n: await pwDelete('all') });
	}
	const onPick = (e: Event) => {
		const inp = e.currentTarget as HTMLInputElement;
		upload([...(inp.files ?? [])]);
		inp.value = '';
	};
	/** Drag & drop, auch ganze Ordner (z. B. den Tagesordner aus ~/Downloads/PredictWind) */
	async function onDrop(e: DragEvent) {
		e.preventDefault();
		over = false;
		const out: File[] = [];
		const walk = async (en: FileSystemEntry | null): Promise<void> => {
			if (!en) return;
			if (en.isFile) out.push(await new Promise<File>((ok, no) => (en as FileSystemFileEntry).file(ok, no)));
			else if (en.isDirectory) {
				const rd = (en as FileSystemDirectoryEntry).createReader();
				for (;;) {
					const batch = await new Promise<FileSystemEntry[]>((ok, no) => rd.readEntries(ok, no));
					if (!batch.length) break;
					for (const b of batch) await walk(b);
				}
			}
		};
		const items = [...(e.dataTransfer?.items ?? [])].map((i) => i.webkitGetAsEntry?.() ?? null);
		if (items.some(Boolean)) for (const en of items) await walk(en);
		else out.push(...(e.dataTransfer?.files ?? []));
		upload(out);
	}
</script>

<section>
	<div class="title">
		<b>{t('GRIB files')}</b>
		<div class="btns">
			<button class="mini" onclick={refresh} disabled={pw.busy} title={t('Read the folder on the Pi again and show new files')}><Icon name="recenter" size={14} /> {pw.busy ? t('loading…') : t('Refresh')}</button>
			{#if st?.files}<button class="mini" onclick={removeAll} title={t('Delete all GRIB files')}><Icon name="trash" size={14} /> {t('Delete all')}</button>{/if}
		</div>
	</div>
	<div class="muted small">{t('GRIB files and routes downloaded with the PredictWind Offshore App appear here as weather models and under Routes.')}</div>
	{#if msg}<div class="small note">{msg}</div>{/if}

	{#if st}
		{#if active}
			<div class="ok small"><Icon name="check" size={14} /> {t('Automatic sync active on “{h}” (last check {t}).', { h: st.ping!.host, t: when(st.ping!.at) })}</div>
		{:else if st.error?.error === 'no-access'}
			<div class="warn small">
				{t('The sync on “{h}” has no access to the Downloads folder ({t}). macOS needs Full Disk Access for “SUKI PredictWind Sync”:', { h: st.error.host, t: when(st.error.at) })}
				<ol>
					<li>{t('Open System Settings → Privacy & Security → Full Disk Access.')} <a href={FDA}>{t('Open settings')}</a></li>
					<li>{t('Click “+”, choose “SUKI PredictWind Sync” in your home folder → Applications, and switch it on.')}</li>
					<li>{t('The status here turns green within 5 minutes.')}</li>
				</ol>
			</div>
		{:else if st.ping}
			<div class="warn small">{t('The sync on “{h}” last reported {t} – Mac asleep, switched off or not on the boat network?', { h: st.ping.host, t: when(st.ping.at) })}</div>
		{:else}
			<div class="muted small">{t('No Mac set up for automatic sync yet.')}</div>
		{/if}
		{#if st.auto}<div class="muted small">{t('Last automatic upload: {f} ({t})', { f: st.auto.file ?? '', t: when(st.auto.at) })}</div>{/if}
		<div class="muted small">{t('On the Pi: {n} GRIB files, {r} readable.', { n: st.files, r: st.readable })}{#if st.unreadable.length}{' '}{t('Not readable (encrypted by PredictWind): {m}.', { m: [...new Set(st.unreadable)].join(', ') })}{/if}{#if st.unused?.length}{' '}{t('No wind, wave or current data (not shown): {m}.', { m: [...new Set(st.unused)].join(', ') })}{/if}</div>
	{/if}

	<details>
		<summary>{t('Set up automatic sync on a Mac (once per computer)')}</summary>
		<ol class="small">
			<li>{t('Open Terminal on the Mac (⌘ Space, type “Terminal”, Enter).')}</li>
			<li>
				{t('Paste this command and press Enter:')}
				<div class="cmd"><code>{cmd}</code><button class="mini" onclick={() => copy(cmd)}>{copied === cmd ? t('Copied') : t('Copy')}</button></div>
			</li>
			<li>{t('System Settings opens at Full Disk Access and a Finder window shows “SUKI PredictWind Sync”: click “+”, add it and switch it on.')} <a href={FDA}>{t('Open settings')}</a></li>
			<li>{t('Done: new downloads are sent to the Pi within a few minutes, also later when the Mac is back on the boat network.')}</li>
		</ol>
		<div class="muted small">{t('Remove from a Mac:')}</div>
		<div class="cmd"><code>{uncmd}</code><button class="mini" onclick={() => copy(uncmd)}>{copied === uncmd ? t('Copied') : t('Copy')}</button></div>
	</details>

	<details open={!!upMsg}>
	<summary>{t('Upload by hand (any computer, iPad)')}</summary>
	<div class="drop" class:over role="region" aria-label={t('Upload by hand')} ondragover={(e) => (e.preventDefault(), (over = true))} ondragleave={() => (over = false)} ondrop={onDrop}>
		<div class="small">{t('Drag files or the day folder here, or choose them:')}</div>
		<label class="btn" class:dis={busy}>
			<Icon name="upload" size={16} /> {t('Choose files')}
			<input type="file" multiple accept=".grb,.grb2,.gpx" onchange={onPick} disabled={busy} hidden />
		</label>
		<div class="muted small">
			{t('Where the Offshore App saves on the Mac (in the file dialog press ⌘⇧G and paste the path):')}
			<div class="paths">
				<span><code>~/Downloads/PredictWind</code> {t('GRIB, one folder per day')}</span><button class="mini" onclick={() => copy('~/Downloads/PredictWind')}>{copied === '~/Downloads/PredictWind' ? t('Copied') : t('Copy')}</button>
				<span><code>~/Downloads</code> {t('routes: Offshore_Route_….gpx (Offshore App) or PredictWind_Route_….gpx (web app)')}</span><button class="mini" onclick={() => copy('~/Downloads')}>{copied === '~/Downloads' ? t('Copied') : t('Copy')}</button>
			</div>
		</div>
		{#if upMsg}<div class="small note">{upMsg}</div>{/if}
	</div>
	</details>
</section>

<style>
	.title { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
	.btns { display: flex; gap: 6px; }
	.mini { min-height: 28px; padding: 2px 8px; font-size: 12px; display: inline-flex; gap: 4px; align-items: center; }
	section { padding: 10px 12px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
	.small { font-size: 12px; }
	.ok { color: var(--ok); display: flex; gap: 6px; align-items: center; font-weight: 600; }
	.warn { color: var(--warn); }
	.note { color: var(--accent); }
	ol { margin: 4px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
	details summary { cursor: pointer; font-size: 13px; font-weight: 600; }
	.cmd { display: flex; gap: 6px; align-items: flex-start; margin-top: 4px; }
	code { font-size: 11.5px; background: var(--btn); border: 1px solid var(--line); border-radius: 6px; padding: 4px 6px; word-break: break-all; flex: 1; }
	.drop { border: 2px dashed var(--line); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
	.drop.over { border-color: var(--accent); background: var(--btn-hi); }
	.btn { display: inline-flex; align-self: flex-start; align-items: center; gap: 6px; cursor: pointer; border: 1px solid var(--line); border-radius: 8px; background: var(--btn); padding: 6px 12px; min-height: 36px; font-size: 14px; }
	.btn.dis { opacity: 0.5; pointer-events: none; }
	.paths { display: grid; grid-template-columns: 1fr auto; gap: 4px 6px; align-items: center; margin-top: 4px; }
	.paths code { flex: none; }
	a { color: var(--accent); }
</style>
