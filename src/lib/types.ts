export type Telemetry = {
	id: number;
	updated_at: string;
	batt_main_soc: number | null;
	batt_main_v: number | null;
	batt_main_a: number | null;
	batt_main_w: number | null;
	batt_main_mode: string | null;
	batt_eng_soc: number | null;
	batt_eng_v: number | null;
	batt_eng_a: number | null;
	solar_p277: number | null;
	solar_p279: number | null;
	solar_p289: number | null;
	solar_p290: number | null;
	solar_p292: number | null;
	solar_total_w: number | null;
	solar_total_a: number | null;
	solar_yield_today_j: number | null;
	solar_yield_yesterday_j: number | null;
	inv_mode: string | null;
	inv_ac_v: number | null;
	inv_ac_hz: number | null;
	inv_ac_w: number | null;
	inv_dc_w: number | null;
	nav_lat: number | null;
	nav_lon: number | null;
	nav_hdg_rad: number | null;
	nav_sog_ms: number | null;
	nav_stw_ms: number | null;
	env_depth_m: number | null;
	env_aws_ms: number | null;
	env_awa_rad: number | null;
	env_tws_ms: number | null;
	env_twa_rad: number | null;
	env_pressure_pa: number | null;
	tank_fw: number | null;
	tank_dsl: number | null;
	tank_bwm: number | null;
	tank_bwg: number | null;
	temp_salon: number | null;
	temp_fridge: number | null;
	temp_tech: number | null;
	temp_amasb: number | null;
	temp_amabb: number | null;
	temp_water: number | null;
	hum_salon: number | null;
	hum_fridge: number | null;
	hum_tech: number | null;
	hum_amasb: number | null;
	hum_amabb: number | null;
	rig_port: number | null;
	rig_sb: number | null;
	eng_rpm: number | null;
	eng_run_sec: number | null;
	eng_temp_k: number | null;
	eng_alt_v: number | null;
	rudder_rad: number | null;
	shelly_108: 0 | 1 | null;
	shelly_102: 0 | 1 | null;
	shelly_118: 0 | 1 | null;
	relay_0: 0 | 1 | null;
	relay_1: 0 | 1 | null;
	server_last_check_ok: boolean | null;
	server_last_check_at: string | null;
};

export type AnchorConfig = {
	id: number;
	updated_at: string;
	boat_id: string | null;
	active: boolean;
	lat: number | null;
	lon: number | null;
	radius_m: number;
	chain_length_m: number;
	bearing_deg: number;
	alarm_delay_s: number;
	alarming: boolean;
	telegram_token: string | null;
	telegram_chat_ids: string | null;
	pushover_app_token: string | null;
	pushover_user_keys: string | null;
	cloud_enabled: boolean;   // legacy — used only by local server.py bridge
	shelly_cloud_server: string | null;
	shelly_cloud_auth_key: string | null;
	vrm_api_token: string | null;
	vrm_installation_id: number | null;
};

export type Boat = {
	id: string;
	name: string;
	created_at: string;
	created_by: string | null;
};

export type BoatMember = {
	boat_id: string;
	user_id: string;
	role: 'admin' | 'viewer';
	invited_by: string | null;
	joined_at: string;
};

export type VRMMppt = {
	name: string;
	instance: number;
	power_w: number;
	yield_today_wh: number;
	yield_total_kwh: number | null;
	pv_v: number | null;
	state: number | null;        // 0=off 3=bulk 4=absorption 5=float 7=equalize
};

export type VRMBattery = {
	name: string;
	instance: number;
	soc: number | null;
	v: number | null;
	a: number | null;
	w: number | null;
	temp_c: number | null;
	time_to_go_s: number | null;
	consumed_ah: number | null;
};

export type VRMTempSensor = {
	name: string;
	instance: number;
	celsius: number;
	humidity: number | null;
};

export type VRMData = {
	// Primary battery (instance 0 or first found)
	battery_soc: number | null;
	battery_v: number | null;
	battery_a: number | null;
	battery_w: number | null;
	// All battery monitors
	batteries: VRMBattery[];
	// Solar
	solar_w: number | null;
	solar_yield_today_wh: number | null;
	mpptsArr: VRMMppt[];
	// AC
	ac_input_v: number | null;
	ac_input_w: number | null;
	ac_output_v: number | null;
	ac_output_w: number | null;
	load_w: number | null;
	// Environment
	temperatures: VRMTempSensor[];
	// Tanks
	tanks: { name: string; level: number }[];
	// GPS
	gps_lat: number | null;
	gps_lon: number | null;
	gps_speed_ms: number | null;
	gps_course_deg: number | null;
	gps_ts: number | null;
	last_ts: number | null;
};

export type ShellyDevice = {
	id: string;
	name: string;
	type: string | null;
	online: boolean;
	state: 0 | 1 | null;
	updated_at: string;
};

export type UserRole = {
	id: string;
	user_id: string;
	role: 'admin' | 'viewer';
	force_password_change: boolean;
	created_at: string;
};

export type RelayDevice = 'victron_relay' | 'shelly';
