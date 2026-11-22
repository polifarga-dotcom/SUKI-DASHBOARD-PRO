// Typen für den Import von watch.mjs in die App (TypeScript)
export type Unit = { t: 'team' | 'person'; id: string };
export type Role = 'skipper' | 'leader' | 'crew';
export interface Crew { id: string; name: string; color: string; role: Role }
export interface Team { id: string; name: string; color: string; members: string[] }
export type Mode = 'rotate' | 'fixed' | 'rolling';
export interface Model { preset: string; mode: Mode; starts: number[]; units: Unit[]; start: string; shift?: number; on?: number; dayOff?: boolean }
export interface Plan { rev: number; active?: boolean; tz: string; crew: Crew[]; teams: Team[]; model: Model; overrides: { start: number; units: Unit[] }[] }
export interface Watch { start: number; end: number; units: Unit[]; members: string[] }
export interface Preset { id: string; name: string; info: string; units: number; mode: Mode; starts: number[]; shift?: number; on?: number; dayOff?: boolean }
export function offAt(doc: Plan, t: number): Unit | null;
export interface NowInfo {
	on: boolean;
	tz?: string;
	now?: { label: string; names: string[] } | null;
	next?: { label: string; names: string[] } | null;
	at?: number | null;
	atText?: string;
	inMin?: number | null;
	soon?: boolean;
	off?: string | null;
}
export const PRESETS: Preset[];
export const COLORS: string[];
export const MAX_CREW: number;
export function zoned(y: number, m: number, d: number, min: number, tz: string): number;
export function validTz(tz: string): boolean;
export function dayOf(t: number, tz: string): { y: number; m: number; d: number };
export function hhmm(t: number, tz: string): string;
export function schedule(doc: Plan, from: number, to: number): Watch[];
export function unitName(doc: Plan, u: Unit): string;
export function restOf(all: Watch[], e: Watch): { rb: number | null; ra: number | null };
export function restText(m: number | null): string;
export function watchList(doc: Plan, from: number, to: number): { s: number; e: number; l: string; c: string; n: number; rb: number | null; ra: number | null }[];
export function watchNow(doc: Plan, t?: number): NowInfo;
export function cleanWatch(d: unknown, now?: number): Plan | string;
export function emptyPlan(tz?: string, today?: string): Plan;
