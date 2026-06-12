<script lang="ts">
	import { supabase } from '$lib/supabase.js';
	import { onMount } from 'svelte';
	import { PUBLIC_SUPABASE_URL } from '$env/static/public';

	let isSuperAdmin = $state(false);
	let checking = $state(true);

	type AdminUser = {
		id: string;
		email: string;
		created_at: string;
		last_sign_in_at: string | null;
		role: string | null;
		is_superadmin: boolean;
		force_password_change: boolean;
		boats: { boat_id: string; boat_name: string; role: string }[];
	};

	type BoatStatus = { signalk: boolean; vrm: boolean; telegram: boolean; pushover: boolean; telemetry_at: string | null };

	let users = $state<AdminUser[]>([]);
	let boatStatus = $state<Record<string, BoatStatus>>({});
	let loading = $state(true);
	let error = $state('');
	let expandedUser = $state<string | null>(null);
	let actionMsg = $state('');
	let actionMsgTimeout: ReturnType<typeof setTimeout>;

	function showMsg(msg: string) {
		actionMsg = msg;
		clearTimeout(actionMsgTimeout);
		actionMsgTimeout = setTimeout(() => (actionMsg = ''), 3000);
	}

	async function loadUsers() {
		loading = true;
		error = '';
		try {
			const { data: { session } } = await supabase.auth.getSession();
			const res = await fetch(`${PUBLIC_SUPABASE_URL}/functions/v1/admin-users`, {
				headers: {
					Authorization: `Bearer ${session?.access_token}`,
					'Content-Type': 'application/json',
				},
			});
			const json = await res.json();
			if (!res.ok) throw new Error(json.error ?? 'Failed to load users');
			users = json.users;
			boatStatus = json.boatStatus ?? {};
		} catch (e: unknown) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	async function callAction(body: object) {
		const { data: { session } } = await supabase.auth.getSession();
		const res = await fetch(`${PUBLIC_SUPABASE_URL}/functions/v1/admin-users`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${session?.access_token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});
		const json = await res.json();
		if (!res.ok) throw new Error(json.error ?? 'Action failed');
		return json;
	}

	async function toggleSuperAdmin(user: AdminUser) {
		try {
			await callAction({ action: 'set_superadmin', user_id: user.id, value: !user.is_superadmin });
			user.is_superadmin = !user.is_superadmin;
			showMsg(`Updated ${user.email}`);
		} catch (e: unknown) {
			showMsg('Error: ' + (e as Error).message);
		}
	}

	async function forcePasswordReset(user: AdminUser) {
		try {
			await callAction({ action: 'reset_password', user_id: user.id });
			user.force_password_change = true;
			showMsg(`Password reset forced for ${user.email}`);
		} catch (e: unknown) {
			showMsg('Error: ' + (e as Error).message);
		}
	}

	async function removeFromBoat(user: AdminUser, boat_id: string, boat_name: string) {
		if (!confirm(`Remove ${user.email} from ${boat_name}?`)) return;
		try {
			await callAction({ action: 'remove_from_boat', user_id: user.id, boat_id });
			user.boats = user.boats.filter(b => b.boat_id !== boat_id);
			showMsg(`Removed from ${boat_name}`);
		} catch (e: unknown) {
			showMsg('Error: ' + (e as Error).message);
		}
	}

	function relTime(iso: string | null): string {
		if (!iso) return 'Never';
		const diff = Date.now() - new Date(iso).getTime();
		const m = Math.floor(diff / 60000);
		if (m < 1) return 'Just now';
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ago`;
		const d = Math.floor(h / 24);
		if (d < 30) return `${d}d ago`;
		return new Date(iso).toLocaleDateString();
	}

	function fmtDate(iso: string): string {
		return new Date(iso).toLocaleDateString();
	}

	// Group boats across all users for boat summary
	const boatSummary = $derived(() => {
		const map: Record<string, { name: string; count: number }> = {};
		for (const u of users) {
			for (const b of u.boats) {
				if (!map[b.boat_id]) map[b.boat_id] = { name: b.boat_name, count: 0 };
				map[b.boat_id].count++;
			}
		}
		return Object.entries(map).map(([id, v]) => ({ id, ...v }));
	});

	onMount(async () => {
		const { data: { user } } = await supabase.auth.getUser();
		if (user?.id) {
			const { data: roleRow } = await supabase
				.from('user_roles')
				.select('is_superadmin')
				.eq('user_id', user.id)
				.single();
			isSuperAdmin = roleRow?.is_superadmin === true;
		}
		checking = false;
		if (isSuperAdmin) loadUsers();
	});
</script>

<svelte:head><title>Admin · SUKI PRO</title></svelte:head>

{#if checking}
<div class="denied"><p style="color:var(--muted)">Loading…</p></div>
{:else if !isSuperAdmin}
<div class="denied">
	<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
	<p>Access denied</p>
</div>
{:else}
<div class="admin-wrap">

	<!-- Header -->
	<div class="adm-hdr">
		<div>
			<span class="adm-title">Admin Panel</span>
			{#if !loading}
			<span class="adm-counts">{users.length} users · {boatSummary().length} boats</span>
			{/if}
		</div>
		<button class="btn-refresh" onclick={loadUsers} title="Refresh">
			<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
				<path d="M4 10a6 6 0 1 1 1.8 4.2"/><polyline points="4 15 4 10 9 10"/>
			</svg>
		</button>
	</div>

	{#if actionMsg}
	<div class="action-msg">{actionMsg}</div>
	{/if}

	{#if error}
	<div class="err-banner">{error}</div>
	{/if}

	<!-- User list -->
	{#if loading}
	<div class="loading">Loading…</div>
	{:else}
	<div class="user-list">
		{#each users as u (u.id)}
		<div class="user-card" class:superadmin={u.is_superadmin}>
			<div class="user-row" role="button" tabindex="0"
				onclick={() => expandedUser = expandedUser === u.id ? null : u.id}
				onkeydown={e => e.key === 'Enter' && (expandedUser = expandedUser === u.id ? null : u.id)}>
				<div class="user-left">
					<div class="user-avatar" class:admin-av={u.is_superadmin}>
						{u.is_superadmin ? '⭐' : (u.email[0] ?? '?').toUpperCase()}
					</div>
					<div class="user-info">
						<div class="user-email">{u.email}</div>
						<div class="user-meta">
							{#if u.is_superadmin}<span class="tag tag-super">superadmin</span>{/if}
							{#if u.force_password_change}<span class="tag tag-warn">pw reset</span>{/if}
							{#if u.boats.length === 0}<span class="tag tag-muted">no boats</span>{/if}
							{#each u.boats as b}
							<span class="tag tag-boat">{b.boat_name} · {b.role}</span>
							{/each}
						</div>
					</div>
				</div>
				<div class="user-right">
					<div class="login-time">{relTime(u.last_sign_in_at)}</div>
					<svg class="expand-icon" class:open={expandedUser === u.id} viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
						<path d="M2 4 L6 8 L10 4"/>
					</svg>
				</div>
			</div>

			{#if expandedUser === u.id}
			<div class="user-detail">
				<div class="detail-grid">
					<div class="detail-item">
						<span class="dl">Joined</span>
						<span class="dv">{fmtDate(u.created_at)}</span>
					</div>
					<div class="detail-item">
						<span class="dl">Last login</span>
						<span class="dv">{u.last_sign_in_at ? fmtDate(u.last_sign_in_at) : 'Never'}</span>
					</div>
					<div class="detail-item">
						<span class="dl">App role</span>
						<span class="dv">{u.role ?? '—'}</span>
					</div>
				</div>

				{#if u.boats.length > 0}
				<div class="boats-section">
					<div class="boats-label">Boat memberships</div>
					{#each u.boats as b}
					<div class="boat-row">
						<span class="boat-name-txt">{b.boat_name}</span>
						<span class="boat-role-txt">{b.role}</span>
						<button class="btn-sm btn-danger" onclick={() => removeFromBoat(u, b.boat_id, b.boat_name)}>Remove</button>
					</div>
					{/each}
				</div>
				{/if}

				<div class="actions-row">
					<button
						class="btn-sm"
						class:btn-super={!u.is_superadmin}
						class:btn-danger={u.is_superadmin}
						onclick={() => toggleSuperAdmin(u)}
					>
						{u.is_superadmin ? 'Remove superadmin' : '⭐ Make superadmin'}
					</button>
					<button class="btn-sm btn-warn" onclick={() => forcePasswordReset(u)}
						disabled={u.force_password_change}>
						{u.force_password_change ? 'Pw reset pending' : 'Force pw reset'}
					</button>
				</div>
			</div>
			{/if}
		</div>
		{/each}
	</div>

	<!-- Boat summary -->
	{#if boatSummary().length > 0}
	<div class="section-title">Boats</div>
	<div class="boats-grid">
		{#each boatSummary() as b}
		{@const st = boatStatus[b.id]}
		<div class="boat-tile">
			<div class="bt-name">{b.name}</div>
			<div class="bt-count">{b.count} member{b.count !== 1 ? 's' : ''}</div>
			{#if st}
			<div class="bt-leds">
				<div class="bt-led" class:on={st.signalk} class:off={!st.signalk} title={st.signalk ? `SignalK live · ${relTime(st.telemetry_at)}` : st.telemetry_at ? `SignalK offline · last seen ${relTime(st.telemetry_at)}` : 'SignalK — no data'}>
					<span class="led-dot"></span><span class="led-lbl">SK</span>
				</div>
				<div class="bt-led" class:on={st.vrm} class:off={!st.vrm} title={st.vrm ? 'VRM configured' : 'VRM not configured'}>
					<span class="led-dot"></span><span class="led-lbl">VRM</span>
				</div>
				<div class="bt-led" class:on={st.telegram} class:off={!st.telegram} title={st.telegram ? 'Telegram configured' : 'Telegram not configured'}>
					<span class="led-dot"></span><span class="led-lbl">TG</span>
				</div>
				<div class="bt-led" class:on={st.pushover} class:off={!st.pushover} title={st.pushover ? 'Pushover configured' : 'Pushover not configured'}>
					<span class="led-dot"></span><span class="led-lbl">PO</span>
				</div>
			</div>
			{/if}
		</div>
		{/each}
	</div>
	{/if}
	{/if}

</div>
{/if}

<style>
	.denied {
		display: flex; flex-direction: column; align-items: center; justify-content: center;
		height: 60vh; gap: 16px; color: var(--red); opacity: 0.7;
	}
	.denied p { font-size: 18px; font-weight: 600; }

	.admin-wrap { max-width: 700px; margin: 0 auto; }

	.adm-hdr {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: 16px;
	}
	.adm-title { font-size: 18px; font-weight: 700; color: var(--text); }
	.adm-counts { font-size: 12px; color: var(--muted); margin-left: 10px; }
	.btn-refresh {
		background: var(--card2); border: 1px solid var(--border); border-radius: 8px;
		padding: 7px 10px; cursor: pointer; color: var(--muted); display: flex; align-items: center;
	}
	.btn-refresh:hover { color: var(--accent); }

	.action-msg {
		background: rgba(0,200,100,0.12); border: 1px solid rgba(0,200,100,0.3);
		color: var(--green); border-radius: 8px; padding: 8px 12px; font-size: 13px;
		margin-bottom: 12px; text-align: center;
	}
	.err-banner {
		background: rgba(255,60,60,0.1); border: 1px solid rgba(255,60,60,0.3);
		color: var(--red); border-radius: 8px; padding: 8px 12px; font-size: 13px;
		margin-bottom: 12px;
	}
	.loading { color: var(--muted); text-align: center; padding: 40px; }

	.user-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }

	.user-card {
		background: var(--card); border: 1px solid var(--border); border-radius: 12px;
		overflow: hidden;
	}
	.user-card.superadmin { border-color: rgba(255, 200, 0, 0.35); }

	.user-row {
		display: flex; align-items: center; justify-content: space-between;
		padding: 12px 14px; cursor: pointer; gap: 10px;
	}
	.user-row:hover { background: var(--card2); }

	.user-left { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
	.user-avatar {
		width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0;
		background: var(--card2); border: 1px solid var(--border);
		display: flex; align-items: center; justify-content: center;
		font-size: 14px; font-weight: 700; color: var(--muted);
	}
	.user-avatar.admin-av { background: rgba(255,200,0,0.12); border-color: rgba(255,200,0,0.35); }

	.user-info { min-width: 0; }
	.user-email { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.user-meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }

	.tag {
		font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px;
		border-radius: 4px; padding: 2px 6px;
	}
	.tag-super { background: rgba(255,200,0,0.15); color: #ffc800; border: 1px solid rgba(255,200,0,0.3); }
	.tag-warn  { background: rgba(255,150,0,0.12); color: var(--amber); border: 1px solid rgba(255,150,0,0.25); }
	.tag-muted { background: var(--card2); color: var(--muted); border: 1px solid var(--border); }
	.tag-boat  { background: rgba(0,200,255,0.08); color: var(--accent); border: 1px solid rgba(0,200,255,0.2); }

	.user-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
	.login-time { font-size: 11px; color: var(--muted); white-space: nowrap; }
	.expand-icon { color: var(--muted); transition: transform 0.2s; }
	.expand-icon.open { transform: rotate(180deg); }

	.user-detail {
		border-top: 1px solid var(--border); padding: 12px 14px;
		display: flex; flex-direction: column; gap: 12px;
	}

	.detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
	.detail-item { display: flex; flex-direction: column; gap: 2px; }
	.dl { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
	.dv { font-size: 13px; color: var(--text); }

	.boats-section { display: flex; flex-direction: column; gap: 6px; }
	.boats-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
	.boat-row {
		display: flex; align-items: center; gap: 8px;
		background: var(--card2); border-radius: 8px; padding: 7px 10px;
	}
	.boat-name-txt { flex: 1; font-size: 13px; font-weight: 500; }
	.boat-role-txt { font-size: 11px; color: var(--muted); }

	.actions-row { display: flex; gap: 8px; flex-wrap: wrap; }

	.btn-sm {
		font-size: 12px; font-weight: 600; border-radius: 7px;
		padding: 6px 12px; border: 1px solid var(--border); cursor: pointer;
		background: var(--card2); color: var(--text); transition: background 0.15s;
	}
	.btn-sm:hover { background: var(--card); }
	.btn-sm:disabled { opacity: 0.5; cursor: default; }
	.btn-super { border-color: rgba(255,200,0,0.35); color: #ffc800; background: rgba(255,200,0,0.08); }
	.btn-super:hover { background: rgba(255,200,0,0.15); }
	.btn-danger { border-color: rgba(255,60,60,0.35); color: var(--red); background: rgba(255,60,60,0.08); }
	.btn-danger:hover { background: rgba(255,60,60,0.15); }
	.btn-warn { border-color: rgba(255,150,0,0.35); color: var(--amber); background: rgba(255,150,0,0.08); }
	.btn-warn:hover { background: rgba(255,150,0,0.15); }

	.section-title {
		font-size: 13px; font-weight: 700; color: var(--muted);
		text-transform: uppercase; letter-spacing: 0.8px;
		margin-bottom: 10px;
	}
	.boats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; }
	.boat-tile {
		background: var(--card); border: 1px solid var(--border); border-radius: 10px;
		padding: 12px 14px;
	}
	.bt-name { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
	.bt-count { font-size: 12px; color: var(--muted); margin-bottom: 10px; }

	.bt-leds {
		display: flex; gap: 6px; flex-wrap: wrap;
	}
	.bt-led {
		display: flex; align-items: center; gap: 3px;
		cursor: default;
	}
	.led-dot {
		width: 7px; height: 7px; border-radius: 50%;
		flex-shrink: 0;
	}
	.bt-led.on .led-dot {
		background: #22c55e;
		box-shadow: 0 0 5px rgba(34,197,94,0.7);
	}
	.bt-led.off .led-dot {
		background: #374151;
		border: 1px solid #4b5563;
	}
	.led-lbl {
		font-size: 9px; font-weight: 700;
		text-transform: uppercase; letter-spacing: 0.4px;
	}
	.bt-led.on  .led-lbl { color: #22c55e; }
	.bt-led.off .led-lbl { color: var(--muted); }
</style>
