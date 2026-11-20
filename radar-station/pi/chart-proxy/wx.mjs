// Wettermodelle (Wind, Welle, Strömung) von Open-Meteo als Gitter um eine Position.
// Der Pi holt und speichert die Vorhersage (offline weiter nutzbar auf Passage), die App zeichnet sie.
// Open-Meteo: frei für nicht-kommerzielle Nutzung, faire Nutzung ≈ 600 Abrufe/min, 10 000/Tag; jede Gitterposition zählt als Abruf.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';

/** res = Modellauflösung in Grad (feineres Gitter bringt nichts) */
export const WX_MODELS = [
	{ id: 'ecmwf_ifs', kind: 'wind', name: 'ECMWF HRES', res: 0.1, info: 'ECMWF IFS 9 km, 15 days', about: 'ECMWF (European Centre for Medium-Range Weather Forecasts, intergovernmental, Reading UK / Bologna IT). High-resolution run of the IFS, generally the most reliable global model, especially beyond 3 days. 9 km still smooths small-scale coastal and island effects (acceleration zones, sea breeze).', about_de: 'ECMWF (Europäisches Zentrum für mittelfristige Wettervorhersage, zwischenstaatlich, Reading UK / Bologna IT). Hochaufgelöster IFS-Lauf, im Mittel das zuverlässigste Globalmodell, besonders ab Tag 3. 9 km glätten aber kleinräumige Küsten- und Inseleffekte (Düsen, Seewind).', region: 'Global', region_de: 'Weltweit' },
	{ id: 'ecmwf_ifs025', kind: 'wind', name: 'ECMWF IFS 0.25°', res: 0.25, info: 'ECMWF IFS 25 km, 15 days', about: 'ECMWF (European Centre for Medium-Range Weather Forecasts). Same IFS model as HRES, but the free 25 km grid: smoother, local gusts and coastal effects are underestimated. Good for the large-scale picture.', about_de: 'ECMWF. Gleiches IFS-Modell wie HRES, aber das freie 25-km-Gitter: glatter, lokale Böen und Küsteneffekte werden unterschätzt. Gut für die Großwetterlage.', region: 'Global', region_de: 'Weltweit' },
	{ id: 'ecmwf_aifs025_single', kind: 'wind', name: 'ECMWF AIFS', res: 0.25, info: 'ECMWF AI model 25 km, 15 days', about: 'ECMWF. AIFS is a machine-learning model trained on ECMWF analyses. Very good at the track of lows and fronts, but tends to smooth peaks; gusts may be missing. Use as a second opinion next to IFS.', about_de: 'ECMWF. AIFS ist ein KI-Modell, trainiert auf ECMWF-Analysen. Sehr gut bei Zugbahnen von Tiefs und Fronten, glättet aber Spitzen; Böen fehlen teils. Als Zweitmeinung neben IFS nutzen.', region: 'Global', region_de: 'Weltweit' },
	{ id: 'gfs_seamless', kind: 'wind', name: 'GFS', res: 0.25, info: 'NOAA GFS 13–25 km, 16 days', about: 'NOAA / NCEP (USA). Global Forecast System, the basis of many apps and GRIB files. Solid worldwide, in Europe slightly behind ECMWF; sometimes overestimates wind over warm seas.', about_de: 'NOAA / NCEP (USA). Global Forecast System, Basis vieler Apps und GRIB-Dateien. Weltweit solide, in Europa etwas hinter ECMWF; überschätzt Wind über warmem Meer gelegentlich.', meta: 'ncep_gfs025', region: 'Global', region_de: 'Weltweit' },
	{ id: 'icon_seamless', kind: 'wind', name: 'ICON', res: 0.0625, info: 'DWD ICON global + EU 7–13 km, 7 days', about: 'DWD (Deutscher Wetterdienst, Germany). ICON global 13 km combined with ICON-EU 7 km over Europe and the Mediterranean. Very good in Europe, gusts are reliable.', about_de: 'DWD (Deutscher Wetterdienst). ICON global 13 km, über Europa und dem Mittelmeer kombiniert mit ICON-EU 7 km. In Europa sehr gut, Böen zuverlässig.', meta: 'dwd_icon', region: 'Global (finer over Europe)', region_de: 'Weltweit (über Europa feiner)' },
	{ id: 'meteofrance_seamless', kind: 'wind', name: 'Météo-France', res: 0.1, info: 'ARPEGE + AROME 1–10 km, 4 days', about: 'Météo-France (France). ARPEGE global/Europe, with AROME 1.3 km near France and Corsica. Outside France only ARPEGE (10–25 km). Only about 4 days ahead.', about_de: 'Météo-France (Frankreich). ARPEGE global/Europa, nahe Frankreich und Korsika AROME 1,3 km. Außerhalb Frankreichs nur ARPEGE (10–25 km). Nur etwa 4 Tage voraus.', meta: 'meteofrance_arpege_world025', region: 'Global (finer over France)', region_de: 'Weltweit (über Frankreich feiner)' },
	{ id: 'meteofrance_arome_france_hd', kind: 'wind', name: 'AROME HD 1.3 km', res: 0.025, poly: [[38.1, -8.1], [38.1, 12.1], [54, 15.6], [55.15, 9.2], [55.2, 2], [55.15, -5.2], [54, -11.7]], area: [38, -11.8, 55.3, 15.7], meta: 'meteofrance_arome_france_hd', info: 'Météo-France AROME 1.3 km, 2 days, no air pressure', about: 'Météo-France (France). Convection-permitting high-resolution model AROME at 1.3 km, new run every 3 h. Area: France, Corsica, Gulf of Lion, Ligurian Sea, Balearics, Sardinia and down to about Sicily (not Malta). Very good for Mistral, Tramontane, sea breeze and gusts near coasts; only about 2 days ahead. This variant has no air pressure (no isobars).', about_de: 'Météo-France (Frankreich). Hochauflösendes Modell AROME mit 1,3 km, neuer Lauf alle 3 h. Gebiet: Frankreich, Korsika, Golfe du Lion, Ligurisches Meer, Balearen, Sardinien bis etwa Sizilien (nicht Malta). Sehr gut für Mistral, Tramontane, Seewind und Böen an Küsten; nur ca. 2 Tage voraus. Diese Variante hat keinen Luftdruck (keine Isobaren).', region: 'W Mediterranean, France, Biscay, Channel', region_de: 'Westl. Mittelmeer, Frankreich, Biskaya, Ärmelkanal' },
	{ id: 'meteofrance_arome_france', kind: 'wind', name: 'AROME 2.5 km', res: 0.025, poly: [[38.1, -8.1], [38.1, 12.1], [54, 15.6], [55.15, 9.2], [55.2, 2], [55.15, -5.2], [54, -11.7]], area: [38, -11.8, 55.3, 15.7], meta: 'meteofrance_arome_france0025', info: 'Météo-France AROME 2.5 km, 2 days', about: 'Météo-France (France). AROME at 2.5 km, new run every 3 h, with air pressure (isobars). Same area as AROME HD: France, Corsica, Balearics, Sardinia down to about Sicily, not Malta. Only about 2 days ahead.', about_de: 'Météo-France (Frankreich). AROME mit 2,5 km, neuer Lauf alle 3 h, mit Luftdruck (Isobaren). Gleiches Gebiet wie AROME HD: Frankreich, Korsika, Balearen, Sardinien bis etwa Sizilien, nicht Malta. Nur ca. 2 Tage voraus.', region: 'W Mediterranean, France, Biscay, Channel', region_de: 'Westl. Mittelmeer, Frankreich, Biskaya, Ärmelkanal' },
	{ id: 'ukmo_seamless', kind: 'wind', name: 'UK Met Office', res: 0.1, info: 'UKMO global 10 km, 7 days', about: 'Met Office (United Kingdom). Global model 10 km, one of the best global models, comparable to ECMWF. Gusts available.', about_de: 'Met Office (Großbritannien). Globalmodell 10 km, eines der besten Globalmodelle, vergleichbar mit ECMWF. Böen verfügbar.', meta: 'ukmo_global_deterministic_10km', region: 'Global', region_de: 'Weltweit' },
	{ id: 'gem_seamless', kind: 'wind', name: 'GEM', res: 0.15, info: 'Environment Canada 15 km, 10 days', about: 'Environment and Climate Change Canada. Global model GDPS 15 km. Good in North America, in Europe and the Mediterranean mainly useful as a comparison model.', about_de: 'Environment and Climate Change Canada (Kanada). Globalmodell GDPS 15 km. In Nordamerika gut, in Europa und dem Mittelmeer vor allem als Vergleichsmodell.', meta: 'cmc_gem_gdps', region: 'Global (finer over N. America)', region_de: 'Weltweit (über Nordamerika feiner)' },
	{ id: 'jma_seamless', kind: 'wind', name: 'JMA', res: 0.5, info: 'Japan Meteorological Agency 55 km, 11 days', about: 'Japan Meteorological Agency. Global model GSM, coarse (about 55 km): fine for the large-scale pattern, not for local winds. Strongest in the Pacific and Asia.', about_de: 'Japan Meteorological Agency (Japan). Globalmodell GSM, grob (ca. 55 km): gut für die Großwetterlage, nicht für lokale Winde. Am stärksten im Pazifik und in Asien.', meta: 'jma_gsm', region: 'Global (finer around Japan)', region_de: 'Weltweit (um Japan feiner)' },
	{ id: 'cma_grapes_global', kind: 'wind', name: 'CMA GRAPES', res: 0.125, info: 'China Meteorological Administration 15 km, 10 days', about: 'China Meteorological Administration. Global model GRAPES 15 km. Little validated in Europe; use only as an additional comparison.', about_de: 'China Meteorological Administration (China). Globalmodell GRAPES 15 km. In Europa wenig erprobt; nur als zusätzlicher Vergleich nutzen.', region: 'Global', region_de: 'Weltweit' },
	{ id: 'italia_meteo_arpae_icon_2i', kind: 'wind', name: 'ItaliaMeteo ICON-2I', res: 0.05, area: [34, 3.2, 48.6, 21.7], info: 'Italy + central Mediterranean 2 km, 3 days', about: 'ItaliaMeteo / Arpae Emilia-Romagna (Italy). ICON-2I 2.2 km for Italy and the central Mediterranean incl. Malta. Shows sea breeze, acceleration zones and local gusts; only about 3 days ahead, no data outside its area.', about_de: 'ItaliaMeteo / Arpae Emilia-Romagna (Italien). ICON-2I 2,2 km für Italien und das zentrale Mittelmeer inkl. Malta. Zeigt Seewind, Düseneffekte und lokale Böen; nur ca. 3 Tage voraus, außerhalb des Gebiets keine Daten.', region: 'Central Mediterranean, Adriatic, Italy, Malta', region_de: 'Zentrales Mittelmeer, Adria, Italien, Malta' },
	{ id: 'icon_eu', kind: 'wind', name: 'ICON-EU', res: 0.0625, area: [25.3, -25.0, 71.2, 63.4], meta: 'dwd_icon_eu', info: 'DWD Europe 7 km, 5 days', about: 'DWD (Deutscher Wetterdienst, Germany). Regional ICON for Europe incl. the whole Mediterranean, North Africa coast and Black Sea, 7 km, new run every 3 h. Reliable all-round model for European waters, gusts included.', about_de: 'DWD (Deutscher Wetterdienst). Regionales ICON für Europa inkl. ganzes Mittelmeer, nordafrikanische Küste und Schwarzes Meer, 7 km, neuer Lauf alle 3 h. Zuverlässiges Allround-Modell für europäische Gewässer, mit Böen.', region: 'Europe, whole Mediterranean, Black Sea, NE Atlantic', region_de: 'Europa, ganzes Mittelmeer, Schwarzes Meer, NO-Atlantik' },
	{ id: 'icon_d2', kind: 'wind', name: 'ICON-D2', res: 0.02, area: [44.3, -0.6, 57.3, 17.5], meta: 'dwd_icon_d2', info: 'DWD Germany + Alps 2 km, 2 days', about: 'DWD (Deutscher Wetterdienst, Germany). ICON-D2 2.2 km for Germany, Benelux, Denmark, the German Bight and western Baltic, Alps. New run every 3 h, about 2 days ahead. Very good for thunderstorms and coastal winds there.', about_de: 'DWD (Deutscher Wetterdienst). ICON-D2 2,2 km für Deutschland, Benelux, Dänemark, Deutsche Bucht und westliche Ostsee, Alpen. Neuer Lauf alle 3 h, ca. 2 Tage voraus. Dort sehr gut für Gewitter und Küstenwind.', region: 'German Bight, W Baltic, Germany, Benelux, Alps', region_de: 'Deutsche Bucht, westl. Ostsee, Deutschland, Benelux, Alpen' },
	{ id: 'meteofrance_arpege_europe', kind: 'wind', name: 'ARPEGE Europe', res: 0.1, area: [20.5, -31.6, 71.6, 41.6], meta: 'meteofrance_arpege_europe', info: 'Météo-France Europe 10 km, 4 days', about: 'Météo-France (France). ARPEGE Europe at about 10 km, new run every 6 h, about 4 days. Good link between AROME (high resolution, short range) and the global models.', about_de: 'Météo-France (Frankreich). ARPEGE Europa mit ca. 10 km, neuer Lauf alle 6 h, ca. 4 Tage. Gutes Bindeglied zwischen AROME (fein, kurz) und den Globalmodellen.', region: 'Europe, Mediterranean, NE Atlantic', region_de: 'Europa, Mittelmeer, NO-Atlantik' },
	{ id: 'dmi_harmonie_arome_europe', kind: 'wind', name: 'DMI HARMONIE', res: 0.02, area: [41.0, -27.3, 67.6, 21.8], meta: 'dmi_harmonie_arome_europe', info: 'Danish Met Institute 2 km, 2.5 days', about: 'DMI (Danish Meteorological Institute, Denmark). HARMONIE-AROME 2 km for north-western Europe: North Sea, Baltic, Skagerrak/Kattegat, British Isles, Iceland area. New run every 3 h. Very good for Scandinavian and Baltic waters.', about_de: 'DMI (Dänisches Meteorologisches Institut). HARMONIE-AROME 2 km für Nordwesteuropa: Nordsee, Ostsee, Skagerrak/Kattegat, Britische Inseln, Raum Island. Neuer Lauf alle 3 h. Sehr gut für skandinavische Gewässer und die Ostsee.', region: 'North Sea, Baltic, British Isles, Iceland area', region_de: 'Nordsee, Ostsee, Britische Inseln, Raum Island' },
	{ id: 'knmi_harmonie_arome_europe', kind: 'wind', name: 'KNMI HARMONIE', res: 0.02, area: [41.2, -27.3, 67.9, 21.6], meta: 'knmi_harmonie_arome_europe', info: 'Dutch Met Institute 2 km, 2.5 days, no pressure', about: 'KNMI (Royal Netherlands Meteorological Institute). HARMONIE-AROME 2 km for western/central Europe incl. Channel, Bay of Biscay and North Sea. New run every hour. No air pressure in this data (no isobars).', about_de: 'KNMI (Königlich Niederländisches Meteorologisches Institut). HARMONIE-AROME 2 km für West-/Mitteleuropa inkl. Ärmelkanal, Biskaya und Nordsee. Neuer Lauf stündlich. Ohne Luftdruck (keine Isobaren).', region: 'North Sea, Channel, Biscay, W/central Europe', region_de: 'Nordsee, Ärmelkanal, Biskaya, West-/Mitteleuropa' },
	{ id: 'metno_nordic', kind: 'wind', name: 'MET Nordic', res: 0.01, area: [53.5, 0.5, 73.3, 29.5], meta: 'metno_nordic_pp', info: 'MET Norway 1 km, 2.5 days', about: 'MET Norway (Norway). MET Nordic 1 km for Norway, Sweden, Finland, Denmark and the Baltic, corrected with weather station data; new run every hour. Best choice for Norwegian fjords and Scandinavian coasts.', about_de: 'MET Norway (Norwegen). MET Nordic 1 km für Norwegen, Schweden, Finnland, Dänemark und die Ostsee, mit Stationsdaten korrigiert; neuer Lauf stündlich. Erste Wahl für norwegische Fjorde und skandinavische Küsten.', region: 'Norway, Sweden, Finland, Baltic', region_de: 'Norwegen, Schweden, Finnland, Ostsee' },
	{ id: 'ukmo_uk_deterministic_2km', kind: 'wind', name: 'UKMO UK 2 km', res: 0.02, area: [46.2, -18.3, 62.3, 9.9], meta: 'ukmo_uk_deterministic_2km', info: 'Met Office UK + Ireland 2 km, 2 days', about: 'Met Office (United Kingdom). UKV 2 km for the British Isles, Channel and Irish Sea; new run every hour, range only about 12 h–2 days depending on the run.', about_de: 'Met Office (Großbritannien). UKV 2 km für Britische Inseln, Ärmelkanal und Irische See; neuer Lauf stündlich, Reichweite je nach Lauf nur ca. 12 h–2 Tage.', region: 'British Isles, Channel, Irish Sea', region_de: 'Britische Inseln, Ärmelkanal, Irische See' },
	{ id: 'ncep_hrrr_conus', kind: 'wind', name: 'HRRR (USA)', res: 0.03, area: [24.9, -125.3, 51.1, -69.9], meta: 'ncep_hrrr_conus', info: 'NOAA USA 3 km, 18–48 h', about: 'NOAA / NCEP (USA). HRRR 3 km for the contiguous USA incl. coastal waters, Great Lakes, Gulf of Mexico edge and northern Bahamas; new run every hour, 18–48 h ahead. Excellent for thunderstorms and sea breeze.', about_de: 'NOAA / NCEP (USA). HRRR 3 km für die USA inkl. Küstengewässer, Große Seen, Rand des Golfs von Mexiko und nördliche Bahamas; neuer Lauf stündlich, 18–48 h voraus. Hervorragend für Gewitter und Seewind.', region: 'USA coastal waters, Great Lakes, N Bahamas', region_de: 'US-Küstengewässer, Große Seen, nördl. Bahamas' },
	{ id: 'ncep_nbm_conus', kind: 'wind', name: 'NBM (USA)', res: 0.03, area: [23.2, -128.5, 55.6, -67.6], meta: 'ncep_nbm_conus', info: 'NOAA National Blend USA 3 km, 11 days, no pressure', about: 'NOAA / NWS (USA). National Blend of Models: statistically calibrated mix of many models, 3 km over the USA, up to about 11 days, hourly updates. Very reliable mean values; no air pressure.', about_de: 'NOAA / NWS (USA). National Blend of Models: statistisch kalibrierte Mischung vieler Modelle, 3 km über den USA, bis ca. 11 Tage, stündlich aktualisiert. Sehr zuverlässige Mittelwerte; ohne Luftdruck.', region: 'USA coastal waters', region_de: 'US-Küstengewässer' },
	{ id: 'gem_hrdps_continental', kind: 'wind', name: 'GEM HRDPS (Canada)', res: 0.025, area: [42.0, -135.6, 61.4, -66.6], meta: 'cmc_gem_hrdps', info: 'Environment Canada 2.5 km, 2 days', about: 'Environment and Climate Change Canada. HRDPS 2.5 km for Canada and the northern USA incl. Atlantic Canada, Great Lakes and the Pacific Northwest; new run every 6 h, 2 days.', about_de: 'Environment and Climate Change Canada (Kanada). HRDPS 2,5 km für Kanada und nördliche USA inkl. Atlantik-Kanada, Große Seen und Pazifischer Nordwesten; neuer Lauf alle 6 h, 2 Tage.', region: 'Canada, northern USA, Great Lakes', region_de: 'Kanada, nördliche USA, Große Seen' },
	{ id: 'gem_regional', kind: 'wind', name: 'GEM RDPS (N. America)', res: 0.1, area: [20.3, -153.9, 89.2, -38.7], meta: 'cmc_gem_rdps', info: 'Environment Canada 10 km, 3.5 days', about: 'Environment and Climate Change Canada. RDPS 10 km for North America and adjacent Atlantic/Pacific waters; new run every 6 h, about 3.5 days.', about_de: 'Environment and Climate Change Canada (Kanada). RDPS 10 km für Nordamerika und angrenzende Atlantik-/Pazifikgewässer; neuer Lauf alle 6 h, ca. 3,5 Tage.', region: 'North America, NW Atlantic, NE Pacific', region_de: 'Nordamerika, NW-Atlantik, NO-Pazifik' },
	{ id: 'jma_msm', kind: 'wind', name: 'JMA MSM (Japan)', res: 0.05, area: [22.6, 120.2, 47.4, 149.8], meta: 'jma_msm', info: 'Japan Meteorological Agency 5 km, 1.5 days, no gusts', about: 'Japan Meteorological Agency. MSM 5 km for Japan, Korea strait and East China Sea; new run every 3 h, about 1.5 days. No gusts in this data.', about_de: 'Japan Meteorological Agency (Japan). MSM 5 km für Japan, Koreastraße und Ostchinesisches Meer; neuer Lauf alle 3 h, ca. 1,5 Tage. Ohne Böen.', region: 'Japan, Korea Strait, East China Sea', region_de: 'Japan, Koreastraße, Ostchinesisches Meer' },
	{ id: 'ecmwf_wam', kind: 'wave', name: 'ECMWF WAM', res: 0.1, info: 'ECMWF wave model 9 km, 15 days', about: 'ECMWF. Wave model WAM, coupled with IFS, 9 km. Wave height = significant wave height (mean of the highest third); single waves can reach about twice that.', about_de: 'ECMWF. Wellenmodell WAM, gekoppelt mit IFS, 9 km. Wellenhöhe = signifikante Wellenhöhe (Mittel des höchsten Drittels); einzelne Wellen können etwa doppelt so hoch sein.', region: 'Global', region_de: 'Weltweit' },
	{ id: 'ecmwf_wam025', kind: 'wave', name: 'ECMWF WAM 0.25°', res: 0.25, info: 'ECMWF wave model 25 km, 15 days', about: 'ECMWF. Wave model WAM on the free 25 km grid. Like WAM 9 km but coarser: bays and island lees are not resolved.', about_de: 'ECMWF. Wellenmodell WAM im freien 25-km-Gitter. Wie WAM 9 km, aber gröber: Buchten und Inselabdeckung werden nicht aufgelöst.', region: 'Global', region_de: 'Weltweit' },
	{ id: 'meteofrance_wave', kind: 'wave', name: 'Météo-France MFWAM', res: 0.1, info: 'Météo-France wave model 8 km, 10 days', about: 'Météo-France via Copernicus Marine (EU). Global wave model MFWAM about 8 km, assimilates satellite wave data. Solid; significant wave height.', about_de: 'Météo-France über Copernicus Marine (EU). Globales Wellenmodell MFWAM ca. 8 km, nutzt Satelliten-Wellendaten. Solide; signifikante Wellenhöhe.', region: 'Global', region_de: 'Weltweit' },
	{ id: 'ncep_gfswave016', kind: 'wave', name: 'GFS Wave 0.16°', res: 0.16, info: 'NOAA WaveWatch III 16 km, 16 days', about: 'NOAA / NCEP (USA). WaveWatch III driven by GFS winds, 16 km grid. Inherits GFS wind errors; coverage of the fine grid depends on region.', about_de: 'NOAA / NCEP (USA). WaveWatch III mit GFS-Wind, 16-km-Gitter. Übernimmt Windfehler von GFS; Abdeckung des feinen Gitters je nach Region.', region: 'Regional grids (Atlantic, Pacific, coasts)', region_de: 'Regionale Gitter (Atlantik, Pazifik, Küsten)' },
	{ id: 'ncep_gfswave025', kind: 'wave', name: 'GFS Wave 0.25°', res: 0.25, info: 'NOAA WaveWatch III 25 km, 16 days', about: 'NOAA / NCEP (USA). WaveWatch III driven by GFS winds, global 25 km grid. Good for swell from far away, coarse near coasts.', about_de: 'NOAA / NCEP (USA). WaveWatch III mit GFS-Wind, globales 25-km-Gitter. Gut für Dünung aus der Ferne, grob in Küstennähe.', region: 'Global', region_de: 'Weltweit' },
	{ id: 'dwd_ewam', kind: 'wave', name: 'DWD EWAM', res: 0.05, info: 'DWD Europe wave model 5 km, 4 days', about: 'DWD (Deutscher Wetterdienst, Germany). European wave model EWAM 5 km incl. Mediterranean, driven by ICON winds. Good near coasts; only about 4 days ahead.', about_de: 'DWD (Deutscher Wetterdienst). Europäisches Wellenmodell EWAM 5 km inkl. Mittelmeer, angetrieben von ICON-Wind. Gut in Küstennähe; nur ca. 4 Tage voraus.', region: 'Europe incl. Mediterranean, Baltic, North Sea', region_de: 'Europa inkl. Mittelmeer, Ostsee, Nordsee' },
	{ id: 'dwd_gwam', kind: 'wave', name: 'DWD GWAM', res: 0.25, info: 'DWD global wave model 25 km, 8 days', about: 'DWD (Deutscher Wetterdienst, Germany). Global wave model GWAM 25 km, driven by ICON winds. Coarse; for open water and swell.', about_de: 'DWD (Deutscher Wetterdienst). Globales Wellenmodell GWAM 25 km, angetrieben von ICON-Wind. Grob; für offenes Wasser und Dünung.', region: 'Global', region_de: 'Weltweit' },
	{ id: 'meteofrance_currents', kind: 'current', name: 'Météo-France SMOC', res: 0.08, info: 'Surface currents incl. tide 8 km, 10 days', about: 'Mercator Ocean / Météo-France via Copernicus Marine (EU). Surface currents SMOC incl. tide and wind drift, about 8 km. Near coasts, in harbours and narrow passages clearly uncertain; tidal streams in straits are underestimated.', about_de: 'Mercator Ocean / Météo-France über Copernicus Marine (EU). Oberflächenströmung SMOC inkl. Gezeiten und Winddrift, ca. 8 km. An Küsten, in Häfen und engen Durchfahrten deutlich unsicher; Gezeitenströme in Meerengen werden unterschätzt.', region: 'Global', region_de: 'Weltweit' }
];
export const wxModel = (id) => WX_MODELS.find((m) => m.id === id);

const KINDS = {
	wind: { url: FORECAST, vars: ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'pressure_msl'], extra: '&wind_speed_unit=kn', k: 1 },
	wave: { url: MARINE, vars: ['wave_height', 'wave_direction', 'wave_period'], extra: '', k: 1 },
	current: { url: MARINE, vars: ['ocean_current_velocity', 'ocean_current_direction'], extra: '', k: 1 / 1.852 } // km/h → kn
};

const MAX_N = 15; // 15 × 15 = 225 Gitterpunkte je Abruf
const snap = (v, s) => Math.round(v / s) * s;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** quadratisches Gitter (≤ MAX_N × MAX_N) um lat/lon mit Halbseite rNm, auf Raster gerundet (stabile Cache-Schlüssel) */
export function wxGrid(lat, lon, rNm, res) {
	const span = (2 * rNm) / 60; // Grad Breite
	const dlat = r3(Math.max(res, Math.ceil(span / (MAX_N - 1) / 0.05) * 0.05));
	const n = Math.min(MAX_N, Math.ceil(span / dlat) + 1);
	const cos = Math.max(0.2, Math.cos((snap(lat, 1) * Math.PI) / 180));
	const dlon = r3(Math.max(res, Math.ceil(dlat / cos / 0.05) * 0.05));
	// große Gebiete: Gitter innerhalb ±89° halten
	const lat0 = r3(Math.max(-89, Math.min(89 - (n - 1) * dlat, snap(lat, dlat) - ((n - 1) / 2) * dlat)));
	const lon0 = r3(snap(lon, dlon) - ((n - 1) / 2) * dlon);
	return { lat0, lon0, dlat, dlon, nx: n, ny: n };
}

/** Gitterpunkte im Modellgebiet (Index y*nx+x); Regionalmodelle brechen sonst die ganze Abfrage ab („No data“) */
/** Punkt im Vieleck [[lat, lon], …] (Strahlverfahren) */
function inPoly(P, la, lo) {
	let c = false;
	for (let i = 0, j = P.length - 1; i < P.length; j = i++)
		if (P[i][0] > la !== P[j][0] > la && lo < ((P[j][1] - P[i][1]) * (la - P[i][0])) / (P[j][0] - P[i][0]) + P[i][1]) c = !c;
	return c;
}

export function wxInside(model, g) {
	const out = [];
	for (let y = 0; y < g.ny; y++)
		for (let x = 0; x < g.nx; x++) {
			const la = g.lat0 + y * g.dlat, lo = g.lon0 + x * g.dlon;
			const a = model.area;
			if (!a || (la >= a[0] && lo >= a[1] && la <= a[2] && lo <= a[3] && (!model.poly || inPoly(model.poly, la, lo)))) out.push(y * g.nx + x);
		}
	return out;
}

export function wxUrl(model, g) {
	const K = KINDS[model.kind];
	const la = [], lo = [];
	for (const i of wxInside(model, g)) {
		la.push(r3(g.lat0 + Math.floor(i / g.nx) * g.dlat));
		lo.push(r3(g.lon0 + (i % g.nx) * g.dlon));
	}
	return `${K.url}?latitude=${la.join(',')}&longitude=${lo.join(',')}&hourly=${K.vars.join(',')}&models=${model.id}&forecast_days=14&timeformat=unixtime&timezone=GMT&cell_selection=${K.url === MARINE ? 'sea' : 'nearest'}${K.extra}`; // Meeresmodelle: „nearest“ bricht bei Landpunkten ganz ab, „sea“ liefert dort null
}

/** Open-Meteo-Antwort (Array je Gitterpunkt) → kompaktes Feld; Werte [t][y][x] flach, null = keine Daten (Land/außerhalb) */
export function wxConvert(model, g, resp) {
	const K = KINDS[model.kind];
	const got = Array.isArray(resp) ? resp : [resp];
	const inside = wxInside(model, g);
	if (got.length !== inside.length) throw new Error(`expected ${inside.length} points, got ${got.length}`);
	// außerhalb des Modellgebiets: kein Punkt (null)
	const locs = new Array(g.nx * g.ny).fill(null);
	inside.forEach((i, k) => (locs[i] = got[k]));
	const time = got[0].hourly.time;
	// hinter dem Modellhorizont liefert Open-Meteo nur null → abschneiden
	let nt = time.length;
	const any = (ti) => got.some((l) => l.hourly[K.vars[0]][ti] != null);
	while (nt > 0 && !any(nt - 1)) nt--;
	const grids = K.vars.map((v, vi) => {
		const out = new Array(nt * locs.length);
		for (let ti = 0; ti < nt; ti++)
			for (let p = 0; p < locs.length; p++) {
				const x = locs[p]?.hourly[v]?.[ti];
				out[ti * locs.length + p] = x == null ? null : vi === 0 ? Math.round(x * K.k * 100) / 100 : Math.round(x * 10) / 10;
			}
		return out;
	});
	return {
		model: model.id,
		kind: model.kind,
		...g,
		t0: time[0] * 1000,
		dt: nt > 1 ? (time[1] - time[0]) * 1000 : 3600e3,
		nt,
		// wind/wave: Richtung „woher“, current: „wohin“ (Open-Meteo-Konvention); p = Böen (wind, kn) bzw. Periode (wave, s)
		s: grids[0],
		d: grids[1],
		p: grids[2] ?? null,
		/** Luftdruck hPa (nur wind) */
		q: grids[3] ?? null
	};
}

/** Modelllauf beim Wetterdienst (nicht unser Abrufzeitpunkt): Open-Meteo-Metadaten des Modells */
export const wxMetaUrl = (model) => `${KINDS[model.kind].url === MARINE ? 'https://marine-api.open-meteo.com' : 'https://api.open-meteo.com'}/data/${model.meta ?? model.id}/static/meta.json`;

/** meta.json → { run: Initialisierung ms, avail: verfügbar seit ms, every: Takt ms } */
export function wxRun(j) {
	if (!j?.last_run_initialisation_time) return null;
	return { run: j.last_run_initialisation_time * 1000, avail: (j.last_run_availability_time ?? 0) * 1000, every: (j.update_interval_seconds ?? 0) * 1000 };
}

const TTL = 6 * 3600e3; // nur ohne Laufdaten (meta.json nicht erreichbar): so lange gilt ein gespeichertes Feld
const META_TTL = 10 * 60e3; // meta.json zählt nicht zum Kontingent, trotzdem höchstens alle 10 min je Modell
const SETTLE = 10 * 60e3; // Open-Meteo empfiehlt, 10 min nach „verfügbar“ zu warten

/** Open-Meteo frei (nicht-kommerziell), je IP: jeder Gitterpunkt zählt als Abruf */
export const WX_LIMITS = { minute: 600, hour: 5000, day: 10000, month: 300000 };
const RESERVE = 0.95; // nicht bis ans Limit: Starlink teilt die IP evtl. mit anderen Nutzern

const err = (code, msg, extra = {}) => Object.assign(new Error(msg), { code, ...extra });

/** Ende des laufenden Zeitfensters (Minute / Stunde / Tag / Monat, UTC) */
export function periodEnd(period, now) {
	if (period === 'month') {
		const d = new Date(now);
		return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
	}
	const unit = { minute: 60e3, hour: 3600e3, day: 86400e3 }[period];
	return Math.floor(now / unit) * unit + unit;
}

/** Zeitpunkt, an dem Open-Meteos Kontingent zurückgesetzt wird (aus dessen Fehlermeldung) */
export function wxLimitReset(why, now) {
	return periodEnd(/daily/i.test(why) ? 'day' : /hourly/i.test(why) ? 'hour' : /monthly/i.test(why) ? 'month' : 'minute', now);
}

/** Gewicht laut Open-Meteo: je Ort 1, anteilig mehr ab 10 Größen bzw. 14 Tagen */
export const wxCost = (points, vars, days) => points * Math.max(1, vars / 10) * Math.max(1, days / 14);

/** eigener Verbrauchszähler je Zeitfenster (UTC), auf dem Pi gespeichert */
export function wxMeter(file = null) {
	let u = {};
	const ready = file ? fs.readFile(file, 'utf8').then((s) => (u = JSON.parse(s)), () => {}) : Promise.resolve();
	const cur = (now) => {
		for (const p of Object.keys(WX_LIMITS)) if (!u[p] || u[p].end <= now) u[p] = { n: 0, end: periodEnd(p, now) };
		return u;
	};
	return {
		ready,
		used: (now = Date.now()) => Object.fromEntries(Object.keys(WX_LIMITS).map((p) => [p, Math.round(cur(now)[p].n)])),
		/** reicht das Kontingent für n Abrufe? sonst das knappste Zeitfenster */
		block(n, now = Date.now()) {
			cur(now);
			for (const p of ['month', 'day', 'hour', 'minute']) if (u[p].n + n > WX_LIMITS[p] * RESERVE) return { period: p, resetAt: u[p].end };
			return null;
		},
		add(n, now = Date.now()) {
			cur(now);
			for (const p of Object.keys(WX_LIMITS)) u[p].n += n;
			if (file) fs.writeFile(file, JSON.stringify(u)).catch(() => {});
		}
	};
}

export function wxStore(dir, fetchImpl = fetch, usageFile = null) {
	const mem = new Map();
	const inflight = new Map(); // gleiche Anfrage von mehreren Geräten → ein Abruf
	const metas = new Map();
	const meter = wxMeter(usageFile);
	let queue = Promise.resolve();
	let blocked = null; // Open-Meteo meldete „limit exceeded“: { until, why }
	const file = (key) => path.join(dir, `${key}.json`);

	async function upstream(model, g) {
		const pts = wxInside(model, g).length;
		if (!pts) throw err('outside', 'outside the model area');
		const cost = wxCost(pts, KINDS[model.kind].vars.length, 14);
		await meter.ready;
		for (;;) {
			const now = Date.now();
			if (blocked && now < blocked.until) throw err('quota', blocked.why, { resetAt: blocked.until, source: 'open-meteo' });
			const b = meter.block(cost, now);
			if (!b) break;
			if (b.period !== 'minute') throw err('quota', `own count: ${b.period} limit reached`, { resetAt: b.resetAt, period: b.period, source: 'own' });
			await new Promise((r) => setTimeout(r, b.resetAt - now + 500)); // Minutenlimit: in der Warteschlange warten
		}
		let r, j;
		try {
			r = await fetchImpl(wxUrl(model, g), { headers: { 'User-Agent': 'suki-radar-station' }, signal: AbortSignal.timeout(60e3) });
			j = await r.json();
		} catch (e) {
			throw err('network', String(e.message ?? e));
		}
		meter.add(cost); // auch Fehlerantworten zählen vorsichtshalber
		if (!r.ok || j.error) {
			const why = j.reason ?? `HTTP ${r.status}`;
			if (/limit exceeded/i.test(why)) {
				blocked = { until: wxLimitReset(why, Date.now()), why };
				throw err('quota', why, { resetAt: blocked.until, source: 'open-meteo' });
			}
			throw err('api', why, { status: r.status });
		}
		return { ...wxConvert(model, g, j), ...(await runOf(model)), cost };
	}

	/** Lauf-Infos (meta.json, zählt nicht zum Kontingent); Fehler sind egal (dann ohne Datenstand) */
	async function runOf(model) {
		const c = metas.get(model.id);
		if (c && Date.now() - c.at < META_TTL) return c.info;
		try {
			const r = await fetchImpl(wxMetaUrl(model), { headers: { 'User-Agent': 'suki-radar-station' }, signal: AbortSignal.timeout(15e3) });
			const info = wxRun(await r.json()) ?? {};
			metas.set(model.id, { at: Date.now(), info });
			return info;
		} catch {
			return {};
		}
	}

	/** gespeichertes Feld noch gültig? Neu abrufen lohnt nur, wenn der Dienst einen neueren Lauf bereitgestellt hat */
	async function current(model, e) {
		const now = Date.now();
		if (e.avail && e.every && now < e.avail + e.every + SETTLE) return true; // nächster Lauf noch nicht fällig
		const info = await runOf(model);
		if (info.run && e.run) {
			if (info.run > e.run && now >= info.avail + SETTLE) return false;
			return true; // derselbe Lauf (oder der neue erst gerade bereitgestellt) → gleiche Daten
		}
		return now - e.fetched < TTL;
	}

	/** irgendein gespeichertes Feld dieses Modells, das den Ort enthält (feinstes zuerst) – Rückfall bei Kontingent/offline */
	async function covering(model, lat, lon) {
		const pre = `${model.id}_v${KINDS[model.kind].vars.length}_`;
		const cands = (await fs.readdir(dir).catch(() => []))
			.filter((f) => f.startsWith(pre) && f.endsWith('.json'))
			.map((f) => {
				const [lat0, , dlat, nx] = f.slice(pre.length, -5).split('_').map(Number);
				return { f, lat0, dlat, nx };
			})
			.filter((c) => lat >= c.lat0 && lat <= c.lat0 + (c.nx - 1) * c.dlat)
			.sort((a, b) => a.dlat - b.dlat);
		for (const c of cands) {
			const e = await fs.readFile(path.join(dir, c.f), 'utf8').then(JSON.parse).catch(() => null);
			if (e && lon >= e.lon0 && lon <= e.lon0 + (e.nx - 1) * e.dlon) return e;
		}
		return null;
	}

	return {
		usage: () => ({ used: meter.used(), limits: WX_LIMITS, reserve: RESERVE, blocked: blocked && Date.now() < blocked.until ? blocked : null }),
		/** Feld für Modell + Position; bei Fehler der letzte gespeicherte Stand (stale + Fehlercode) */
		async get(model, lat, lon, rNm) {
			const g = wxGrid(lat, lon, rNm, model.res);
			const key = `${model.id}_v${KINDS[model.kind].vars.length}_${g.lat0}_${g.lon0}_${g.dlat}_${g.nx}`; // v = Variablenzahl: neue Größen → neuer Schlüssel
			let e = mem.get(key);
			if (!e) {
				e = await fs.readFile(file(key), 'utf8').then(JSON.parse).catch(() => null);
				if (e) mem.set(key, e);
			}
			if (e && e.run === undefined) Object.assign(e, { run: null }, await runOf(model)); // Felder von vor dem Datenstand-Update
			if (e && (await current(model, e))) return { ...e, next: e.avail && e.every ? e.avail + e.every : null };
			let job = inflight.get(key);
			if (!job) {
				job = queue.then(() => upstream(model, g));
				queue = job.catch(() => {});
				inflight.set(key, job);
				job.catch(() => {}).finally(() => inflight.delete(key));
			}
			try {
				const f = { ...(await job), fetched: Date.now() };
				mem.set(key, f);
				await fs.mkdir(dir, { recursive: true });
				await fs.writeFile(file(key) + '.tmp', JSON.stringify(f));
				await fs.rename(file(key) + '.tmp', file(key));
				return { ...f, next: f.avail && f.every ? f.avail + f.every : null };
			} catch (x) {
				const info = { error: String(x.message ?? x), code: x.code ?? 'api', resetAt: x.resetAt ?? null };
				if (e) return { ...e, stale: true, ...info };
				const alt = x.code === 'outside' ? null : await covering(model, lat, lon);
				if (alt) return { ...alt, stale: true, ...info };
				throw Object.assign(x, info);
			}
		},
		/** gespeicherte Felder älter als maxDays löschen */
		async prune(maxDays = 3) {
			for (const f of await fs.readdir(dir).catch(() => [])) {
				const p = path.join(dir, f);
				const st = await fs.stat(p).catch(() => null);
				if (st && Date.now() - st.mtimeMs > maxDays * 86400e3) await fs.rm(p, { force: true });
			}
			mem.clear();
		}
	};
}
