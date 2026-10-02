export type ModeId = 'ctf' | 'blitz' | 'tdm' | 'rabbit' | 'arena' | 'cah' | 'training';

export interface ModeDef {
  id: ModeId;
  name: string;
  short: string;
  teams: boolean;
  scoreLimit: number;
  timeLimit: number; // minutes
  usesBases: boolean;
  vehicles: boolean;
  callIns: boolean;
  respawnTickets?: number;
  roundsToWin?: number;
  rules: string[];
  internalPrefix: string;
}

// Rules text mirrors TribesGame.int RulesFor* so the in-game help matches the original.
export const MODES: Record<ModeId, ModeDef> = {
  ctf: { id: 'ctf', name: 'Capture the Flag', short: 'CTF', teams: true, scoreLimit: 5, timeLimit: 20, usesBases: true, vehicles: true, callIns: true, internalPrefix: 'TrCTF',
    rules: ['Prevent enemy from capturing your flag.', 'Take enemy flag back to your stand to capture.', 'To capture, your flag must be at its stand.', 'Five captures to win.'] },
  blitz: { id: 'blitz', name: 'CTF Blitz', short: 'BLITZ', teams: true, scoreLimit: 5, timeLimit: 15, usesBases: false, vehicles: false, callIns: false, internalPrefix: 'TrCTFBlitz',
    rules: ['Flag positions rotate after each capture.', 'Prevent enemy from capturing your flag.', 'Take enemy flag back to your stand to capture.', 'To capture, your flag must be at its stand.', 'Five captures to win.'] },
  tdm: { id: 'tdm', name: 'Team Deathmatch', short: 'TDM', teams: true, scoreLimit: 100, timeLimit: 15, usesBases: false, vehicles: false, callIns: true, internalPrefix: 'TrTeamRabbit',
    rules: ['Eliminate the opposing team\'s forces.', 'First player death spawns a flag.', 'Team holding the flag gets double points for kills.'] },
  rabbit: { id: 'rabbit', name: 'Rabbit', short: 'RABBIT', teams: false, scoreLimit: 30, timeLimit: 15, usesBases: false, vehicles: false, callIns: false, internalPrefix: 'TrRabbit',
    rules: ['Grab the flag to score a point.', 'Hold onto the flag to gain more points.', 'Kill enemy players to score.', 'Game to 30 points.'] },
  arena: { id: 'arena', name: 'Arena', short: 'ARENA', teams: true, scoreLimit: 2, timeLimit: 10, usesBases: false, vehicles: false, callIns: false, respawnTickets: 25, roundsToWin: 2, internalPrefix: 'TrArena',
    rules: ['Eliminate the opposing team\'s forces.', 'The team that wins two rounds wins the match.', 'Each team has 25 respawns.', 'After team respawns are depleted, players get one more life.'] },
  cah: { id: 'cah', name: 'Capture and Hold', short: 'CAH', teams: true, scoreLimit: 100, timeLimit: 20, usesBases: true, vehicles: true, callIns: true, internalPrefix: 'TrCaH',
    rules: ['Capture and hold the various Control Points.', 'A Control Point is captured by touching a point\'s switch.', 'Once a Control Point has been held for 5 seconds, the owning team gains a score.', 'Held Control Points generate a score every 5 seconds.', 'The team that reaches the goal score wins.'] },
  training: { id: 'training', name: 'Ski Training', short: 'TRAIN', teams: false, scoreLimit: 0, timeLimit: 0, usesBases: false, vehicles: true, callIns: false, internalPrefix: 'TrTraining',
    rules: ['Hold Space to ski down slopes.', 'Hold Right Mouse to jet.', 'Ski down hills and jet up the next to keep your speed.'] },
};

export const MODE_IDS = Object.keys(MODES) as ModeId[];
