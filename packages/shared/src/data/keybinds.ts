// Defaults mirror TribesGame/Config/DefaultInput.ini (TrPlayerInput + TrPlayerInput_Spectator).
// Keys use KeyboardEvent.code; mouse buttons are Mouse0 (left), Mouse1 (middle), Mouse2 (right), WheelUp, WheelDown.

export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'ski' | 'jump' | 'jet' | 'fire' | 'lastWeapon' | 'use' | 'reload'
  | 'melee' | 'pack' | 'belt' | 'behindView' | 'dropFlag' | 'freeCam' | 'menu' | 'classes' | 'deployables'
  | 'horn' | 'scores' | 'talk' | 'teamTalk' | 'reply' | 'netStats' | 'vgs' | 'zoom' | 'objectMarkers'
  | 'seat1' | 'seat2' | 'seat3' | 'seat4' | 'voteNo' | 'voteYes' | 'quickClasses' | 'spot' | 'suicide'
  | 'toggleChat' | 'weapon1' | 'weapon2' | 'weapon3' | 'weapon4' | 'callIn1' | 'callIn2' | 'callIn3'
  | 'teamSelect' | 'mainMenu' | 'settings' | 'weaponPrev' | 'weaponNext' | 'overheadMap'
  | 'class1' | 'class2' | 'class3' | 'class4' | 'class5' | 'class6' | 'class7' | 'class8' | 'class9';

export const DEFAULT_BINDS: Record<Action, string[]> = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA'], right: ['KeyD'],
  ski: ['Space'], jump: ['ControlLeft'], jet: ['Mouse2'], fire: ['Mouse0'],
  lastWeapon: ['KeyQ'], use: ['KeyG'], reload: ['KeyR'], melee: ['KeyE'], pack: ['KeyC'], belt: ['KeyF'],
  behindView: ['KeyX'], dropFlag: ['KeyZ'], freeCam: ['Mouse1'], menu: ['Escape'], classes: ['KeyI'],
  deployables: ['KeyU'], horn: ['KeyH'], scores: ['Tab'], talk: ['KeyT'], teamTalk: ['KeyY'], reply: ['Slash'],
  netStats: ['F10'], vgs: ['KeyV'], zoom: ['ShiftLeft'], objectMarkers: ['KeyO'],
  seat1: ['F1'], seat2: ['F2'], seat3: ['F3'], seat4: ['F4'], voteNo: ['F5'], voteYes: ['F6'],
  quickClasses: ['Enter'], spot: ['AltLeft'], suicide: ['KeyK'], toggleChat: ['Backquote'],
  weapon1: ['Digit1'], weapon2: ['Digit2'], weapon3: ['Digit3'], weapon4: ['Digit4'],
  callIn1: ['Digit5'], callIn2: ['Digit6'], callIn3: ['Digit7'],
  teamSelect: ['KeyP'], mainMenu: ['KeyM'], settings: ['KeyN'], weaponPrev: ['WheelUp'], weaponNext: ['WheelDown'], overheadMap: ['KeyB'],
  class1: ['Numpad1'], class2: ['Numpad2'], class3: ['Numpad3'], class4: ['Numpad4'], class5: ['Numpad5'],
  class6: ['Numpad6'], class7: ['Numpad7'], class8: ['Numpad8'], class9: ['Numpad9'],
};

export type SpectatorAction =
  | 'up' | 'down' | 'forward' | 'back' | 'left' | 'right' | 'speedUp' | 'speedDown' | 'nextPlayer' | 'prevPlayer'
  | 'viewSelf' | 'bookmarks' | 'generators' | 'flagStands' | 'flags' | 'vehicles' | 'fastest' | 'controls' | 'hud'
  | 'scores' | 'menu' | 'teamSelect' | 'objectMarkers' | 'lockView';

export const SPECTATOR_BINDS: Record<SpectatorAction, string[]> = {
  up: ['KeyE'], down: ['KeyQ'], forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  speedUp: ['WheelUp'], speedDown: ['WheelDown'], nextPlayer: ['Mouse0'], prevPlayer: ['Mouse2'], viewSelf: ['Mouse1'],
  bookmarks: ['KeyC'], generators: ['KeyG'], flagStands: ['KeyB'], flags: ['KeyF'], vehicles: ['KeyV'], fastest: ['KeyR'],
  controls: ['KeyZ'], hud: ['KeyX'], scores: ['Tab'], menu: ['Escape'], teamSelect: ['KeyP'], objectMarkers: ['KeyO'], lockView: ['KeyL'],
};

export const ACTION_LABELS: Partial<Record<Action, string>> = {
  forward: 'Move Forward', back: 'Move Backward', left: 'Strafe Left', right: 'Strafe Right', ski: 'Ski', jump: 'Jump', jet: 'Jetpack',
  fire: 'Fire', lastWeapon: 'Last Weapon', use: 'Use', reload: 'Reload', melee: 'Melee', pack: 'Activate Pack', belt: 'Throw Belt Item',
  behindView: 'Third Person', dropFlag: 'Drop Flag', freeCam: 'Free Look', classes: 'Class Select', deployables: 'Deployables',
  scores: 'Scoreboard', talk: 'Chat (All)', teamTalk: 'Chat (Team)', vgs: 'Voice Game System', zoom: 'Zoom', spot: 'Spot Target',
  quickClasses: 'Quick Classes', suicide: 'Suicide', weapon1: 'Primary', weapon2: 'Secondary', weapon3: 'Belt', weapon4: 'Pack',
  callIn1: 'Call-In: Tactical Strike', callIn2: 'Call-In: Supply Drop', callIn3: 'Call-In: Orbital Strike', netStats: 'Net Stats',
  teamSelect: 'Team Select', voteYes: 'Vote Yes', voteNo: 'Vote No', objectMarkers: 'Object Markers', overheadMap: 'Overhead Map',
};
