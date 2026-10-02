import type { ModeId } from './modes.js';

// Loading-screen tips and armor blurbs, from TribesGame.int (monetisation/XP tips omitted: everything is unlocked).
const CTF = [
  'Generators provide power to base defenses and vehicle pads, as well as player deployables like force fields, light turrets, and sensor jammers.',
  'Repair tool stations can be found inside bases and around generators, and may be used by any class to swap your current weapon with a Repair Tool by pressing (default: G).',
  'Repairing base defenses and your Generator will reward you with credits, in addition to helping your team.',
  'Base Assets such as the Base Turrets or Generator may be upgraded by spending credits you earn during a match by pressing (default: G). Upgraded turrets shoot faster and can take more damage.',
  'Base Radar Stations will spot and mark all enemies within range, even those outside of your line of sight.',
  "Vehicles may be purchased at any time by using credits you earn in a match, though your team's Generator must be online for you to access the vehicle station.",
  'Armored Targets such as Vehicles and Base Turrets can only be damaged with explosive weaponry.',
];
const GENERIC = [
  'Call-Ins such as Orbital Strike or Supply Drop may be purchased any time by using credits you earn in a match.',
  'All classes have a melee weapon which you can use by pressing (default: E).',
  'Press (default V) to access a set of quick voice commands for communication with your team.',
  'While holding an enemy flag you will not regenerate health. You can throw the flag by pressing (default Z).',
  'You earn credits in a match by scoring kills, repairing defenses, returning or grabbing flags, and being awarded accolades.',
  'Player deployables are powered by the Generator. If it is down your team\'s deployables will be offline until the generator is operational once again.',
  'You can change your zoom level by using the middle-mouse wheel.',
  'Press (default B) to open the overhead map.',
];
const BY_MODE: Partial<Record<ModeId, string[]>> = {
  ctf: CTF, blitz: CTF,
  tdm: ['While holding an enemy flag you will not regenerate health. You can throw the flag by pressing (default Z).'],
  rabbit: ['While holding the flag you will not regenerate health - in Rabbit, you cannot throw the flag.'],
  arena: [
    'Spot enemies (default: Left Alt) to help identify targets for your teammates.',
    'In Arena mode, deployables are destroyed when the owning player dies.',
    'When you spawn in Arena mode, you are invulnerable until you fire your first shot or 5 seconds has passed, whichever comes first.',
  ],
  cah: ['Damaged defenses will return up to half-health when a point is successfully held by a team.'],
};

export function randomTip(mode: ModeId): string {
  const list = [...(BY_MODE[mode] ?? []), ...GENERIC];
  return list[Math.floor(Math.random() * list.length)];
}

export const ARMOR_BLURB: Record<'light' | 'medium' | 'heavy', string> = {
  light: 'Light Armor is extremely fast and is best suited for flag capping and chasing. It may be outfitted to fill sniping or infiltration roles.',
  medium: 'Medium armor finds the balance between speed and survivability. It may also be outfitted to fill base building/repair or base disruption roles.',
  heavy: 'Heavy armor is extremely resilient and is unmatched in long range bombardment capabilities. It may be outfitted to fill Heavy on Flag or base destruction roles.',
};
