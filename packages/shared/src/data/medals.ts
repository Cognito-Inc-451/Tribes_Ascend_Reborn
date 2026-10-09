/**
 * Player accolades (medals), modelled on Tribes: Ascend's accolade list.
 *
 * Each medal is a one-shot award the server grants for a specific feat. The
 * server owns the trigger logic (see server/src/game/Match.ts); this table is
 * the shared source of truth so the HUD can show the same name, credit value
 * and icon the awarding side announced.
 *
 * `icon` is an item id (resolved by the HUD's weapon-glyph table) or the name
 * of a raw glyph kind, so medals reuse the existing kill-feed icon art.
 */

export type MedalTier = 'normal' | 'streak' | 'multi' | 'big';

export interface MedalDef {
  id: string;
  name: string;
  credits: number;
  icon: string;
  tier: MedalTier;
  /** Announced in chat when earned (TA broadcast the top kill streaks). */
  broadcast?: string;
}

const medal = (id: string, name: string, credits: number, icon: string, tier: MedalTier = 'normal', broadcast?: string): MedalDef =>
  ({ id, name, credits, icon, tier, broadcast });

export const MEDALS: Record<string, MedalDef> = Object.fromEntries(
  [
    // ------------------------------------------------- kill-adjacent feats
    medal('first_blood', 'First Blood', 500, 'melee'),
    medal('revenge', 'Revenge', 300, 'melee'),
    medal('no_joy', 'No Joy', 300, 'rifle'),
    medal('martial_art', 'Martial Art', 200, 'knife'),
    medal('head_shot', 'Head Shot', 200, 'headshot'),
    medal('blue_plate', 'Blue Plate Special', 200, 'disc'),
    medal('air_mail', 'Air Mail', 200, 'grenade'),
    medal('hot_air', 'Hot Air', 150, 'rifle'),
    medal('sticky_kill', 'Sticky Kill', 200, 'mine'),
    medal('road_kill', 'Road Kill', 100, 'vehicle'),
    medal('flag_killer', 'Flag Killer', 250, 'pack'),
    medal('flag_defender', 'Flag Defender', 300, 'pack'),
    medal('gener_defender', 'Gener Defender', 300, 'deploy'),
    medal('gener_hater', 'Gener-Hater', 500, 'deploy'),
    medal('rabbit_season', 'Rabbit Season', 200, 'knife'),
    medal('caerbannog', 'Caerbannog', 500, 'knife'),
    medal('final_blow', 'Final Blow', 500, 'rifle'),

    // ------------------------------------------------------- kill streaks
    medal('killing_spree', 'Killing Spree', 300, 'rifle', 'streak'),
    medal('rampage', 'Rampage', 500, 'rifle', 'streak'),
    medal('relentless', 'Relentless', 1000, 'rifle', 'streak'),
    medal('unstoppable', 'Unstoppable', 2000, 'rifle', 'streak', '$P is Unstoppable!'),
    medal('the_slayer', 'The Slayer', 3000, 'rifle', 'streak', '$P is The Slayer!'),
    medal('classic_spree', 'Classic Spree', 300, 'disc', 'streak'),
    medal('disc_jockey', 'Disc Jockey', 500, 'disc', 'streak'),
    medal('tribal_fanatic', 'Tribal Fanatic', 1000, 'disc', 'streak', '$P is a Tribal Fanatic.'),
    medal('explosive_spree', 'Explosive Spree', 300, 'launcher', 'streak'),
    medal('demolitions_expert', 'Demolitions Expert', 500, 'launcher', 'streak'),
    medal('hurt_locker', 'Hurt Locker', 1000, 'launcher', 'streak', '$P calls in the hurt locker.'),
    medal('sniping_spree', 'Sniping Spree', 300, 'rifle', 'streak'),
    medal('sharpshooter', 'Sharpshooter', 500, 'rifle', 'streak', '$P is a Sharpshooter.'),
    medal('marksman', 'Marksman', 1000, 'rifle', 'streak', '$P is a Marksman.'),

    // ------------------------------------------------------ multi-kills
    medal('double_kill', 'Double Kill', 500, 'rifle', 'multi'),
    medal('triple_kill', 'Triple Kill', 1000, 'rifle', 'multi'),
    medal('quatra_kill', 'Quatra Kill', 2000, 'rifle', 'multi'),
    medal('ultra_kill', 'Ultra Kill', 3000, 'rifle', 'multi'),
    medal('team_kill', 'Team Kill', 4000, 'rifle', 'multi'),

    // -------------------------------------------------- vehicles, assets
    medal('bike_down', 'Bike Down', 200, 'vehicle'),
    medal('shrike_down', 'Shrike Down', 700, 'vehicle'),
    medal('tank_down', 'Tank Down', 500, 'vehicle'),
    medal('radar_down', 'Radar Down', 200, 'deploy'),
    medal('turret_down', 'Turret Down', 200, 'turret'),
    medal('aftermath', 'Aftermath', 200, 'disc'),
    medal('vehicle_assist', 'Vehicle Assist', 250, 'vehicle'),

    // ------------------------------------------------------------ call-ins
    medal('artillery_strike', 'Artillery Strike', 500, 'strike'),
    medal('orbital_strike', 'Orbital Strike', 500, 'strike'),
    medal('investor', 'Investor', 200, 'pack'),

    // -------------------------------------------------------------- flags
    medal('flag_grab', 'Flag Grab', 200, 'pack'),
    medal('flag_return', 'Flag Return', 250, 'pack'),
    medal('flag_capture', 'Flag Capture', 2000, 'pack', 'big'),
    medal('flag_take', 'Flag Take', 250, 'pack'),
    medal('capture_assist', 'Capture Assist', 1000, 'pack', 'big'),
    medal('flag_held', 'Flag Held', 100, 'pack'),
    medal('e_grab', 'E-Grab', 500, 'pack'),
    medal('gotta_go_fast', 'Gotta Go Fast', 300, 'pack'),
    medal('high_speed_grab', 'High Speed Grab', 250, 'pack'),
    medal('llama_grab', 'Llama Grab', 150, 'pack'),

    // ------------------------------------------------- repair, rounds, arena
    medal('base_repair', 'Base Repair', 25, 'repair'),
    medal('capture_and_hold', 'Capture and Hold', 200, 'deploy'),
    medal('hold_the_line', 'Hold the Line', 100, 'deploy'),
    medal('round_completed', 'Round Completed', 1000, 'other', 'big'),
    medal('round_victory', 'Round Completed - Victory', 500, 'other', 'big'),
    medal('bench_em', 'Bench Em', 200, 'rifle'),
    medal('united_we_stand', 'United We Stand', 1000, 'other', 'big'),
    medal('last_man_standing', 'Last Man Standing', 200, 'rifle', 'big'),
    medal('double_down', 'Double Down', 2000, 'rifle', 'big'),
    medal('not_among_equals', 'Not Among Equals', 4000, 'rifle', 'big'),
    medal('one_man_army', 'One Man Army', 6000, 'rifle', 'big'),
    medal('miracle', 'Miracle', 10000, 'rifle', 'big'),
  ].map((m) => [m.id, m]),
);

/** Kills inside this window chain into a multi-kill accolade. */
export const MEDAL_MULTI_WINDOW = 4;
/** Seconds a flag must be carried for the Flag Held accolade. */
export const MEDAL_FLAG_HOLD_TIME = 10;
/** Speed (km/h) thresholds for the flag-grab accolades. */
export const MEDAL_GRAB_SPEED_FAST = 175;
export const MEDAL_GRAB_SPEED_HIGH = 135;
export const MEDAL_GRAB_SPEED_SLOW = 40;
/** Seconds a cap point must be held for Hold the Line. */
export const MEDAL_HOLD_LINE_TIME = 15;
/** Radius (m) around a flag stand / generator a defender kill counts in. */
export const MEDAL_DEFENSE_RADIUS = 30;
/** Seconds of the capture chain a teammate can have carried the flag in for Capture Assist. */
export const MEDAL_ASSIST_WINDOW = 60;
/** Hit points repaired that unlock the Base Repair accolade. */
export const MEDAL_REPAIR_AMOUNT = 250;

/** Kill counts that unlock each streak tier, lowest first. */
export const MEDAL_STREAKS = {
  general: [
    { kills: 5, id: 'killing_spree' },
    { kills: 10, id: 'rampage' },
    { kills: 15, id: 'relentless' },
    { kills: 20, id: 'unstoppable' },
    { kills: 25, id: 'the_slayer' },
  ],
  spinfusor: [
    { kills: 5, id: 'classic_spree' },
    { kills: 10, id: 'disc_jockey' },
    { kills: 15, id: 'tribal_fanatic' },
  ],
  explosive: [
    { kills: 5, id: 'explosive_spree' },
    { kills: 10, id: 'demolitions_expert' },
    { kills: 15, id: 'hurt_locker' },
  ],
  sniper: [
    { kills: 5, id: 'sniping_spree' },
    { kills: 10, id: 'sharpshooter' },
    { kills: 15, id: 'marksman' },
  ],
} as const;

/** Multi-kill tiers, keyed by the number of kills in the chain. */
export const MEDAL_MULTI_KILLS: Record<number, string> = {
  2: 'double_kill',
  3: 'triple_kill',
  4: 'quatra_kill',
  5: 'ultra_kill',
  6: 'team_kill',
};
