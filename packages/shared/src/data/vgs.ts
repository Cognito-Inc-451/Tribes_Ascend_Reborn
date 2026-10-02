// Voice Game System tree. Phrases are TribesGame.int ChatString_* values; key letters follow the classic V-menu layout.

export interface VgsLeaf { key: string; id: string; text: string; global?: boolean }
export interface VgsNode { key: string; label: string; children: (VgsNode | VgsLeaf)[] }
export const isVgsNode = (n: VgsNode | VgsLeaf): n is VgsNode => 'children' in n;

const L = (key: string, id: string, text: string, global = false): VgsLeaf => ({ key, id, text, global });
const N = (key: string, label: string, children: (VgsNode | VgsLeaf)[]): VgsNode => ({ key, label, children });
const points = (prefix: string, verb: string, self = false) =>
  ['A', 'B', 'C', 'D', 'E'].map((p) => L(p, `${prefix}Point${p}`, self ? `I'll ${verb} point ${p}.` : `${verb[0].toUpperCase()}${verb.slice(1)} point ${p}!`));

export const VGS_ROOT: VgsNode = N('V', 'Root Menu', [
  N('A', 'Attack', [
    L('A', 'Attack', 'Attack!'), L('B', 'AttackBase', 'Attack the enemy base!'), L('C', 'AttackChase', 'Chase the enemy flag carrier!'),
    L('D', 'AttackDisrupt', 'Disrupt the enemy defense!'), L('F', 'AttackFlag', 'Get the enemy flag!'), L('G', 'AttackGenerator', 'Destroy the enemy generator!'),
    L('R', 'AttackReinforce', 'Reinforce the offense!'), L('S', 'AttackSensors', 'Destroy enemy sensors!'), L('T', 'AttackTurrets', 'Destroy enemy turrets!'),
    L('V', 'AttackVehicle', 'Destroy the enemy vehicle!'), L('W', 'AttackWait', 'Wait for my signal before attacking!'),
    N('P', 'Point', points('Attack', 'attack')),
  ]),
  N('B', 'Base', [
    L('C', 'BaseClear', 'Our base is clear.'), L('E', 'EnemyInBase', 'The enemy is in our base.'), L('R', 'BaseRetake', 'Retake our base!'), L('S', 'BaseSecure', 'Secure our base!'),
  ]),
  N('C', 'Command', [
    L('A', 'CommandAcknowledged', 'Acknowledged.'), L('C', 'CommandCompleted', 'Completed.'), L('D', 'CommandDeclined', 'Declined.'), L('W', 'CommandAssignment', "What's my assignment?"),
  ]),
  N('D', 'Defend', [
    L('B', 'DefendBase', 'Defend our base!'), L('C', 'DefendFlagCarrier', 'Defend the flag carrier!'), L('E', 'DefendEntrances', 'Defend the entrances!'),
    L('F', 'DefendFlag', 'Defend our flag!'), L('G', 'DefendGenerator', 'Defend our generator!'), L('M', 'DefendMe', 'Cover me!'),
    L('R', 'DefendReinforce', 'Reinforce our defense!'), L('S', 'DefendSensors', 'Defend our sensors!'), L('T', 'DefendTurrets', 'Defend our turrets!'),
    L('V', 'DefendVehicle', 'Defend our vehicle!'), N('P', 'Point', points('Defend', 'defend')),
  ]),
  N('E', 'Enemy', [
    L('D', 'EnemyDisarray', 'The enemy is in disarray.'), L('G', 'EnemyGeneratorDestroyed', 'The enemy generator is destroyed.'),
    L('S', 'EnemySensorsDestroyed', 'The enemy sensors are destroyed.'), L('T', 'EnemyTurretsDestroyed', 'The enemy turrets are destroyed.'),
    L('V', 'EnemyVehicleDestroyed', 'The enemy vehicle is destroyed.'),
  ]),
  N('F', 'Flag', [
    L('D', 'FlagDefend', 'Defend our flag!'), L('G', 'FlagGiveMe', 'Give me the flag!'), L('H', 'FlagIHave', 'I have the flag!'),
    L('R', 'FlagRetrieve', 'Retrieve our flag!'), L('E', 'FlagSelfRetrieve', "I'll retrieve our flag!"), L('S', 'FlagSecure', 'Our flag is secure.'),
    L('T', 'FlagTake', 'Take the flag from me!'),
  ]),
  N('G', 'Global', [
    L('Y', 'GlobalYes', 'Yes.', true), L('N', 'GlobalNo', 'No.', true), L('H', 'GlobalHi', 'Hi.', true), L('B', 'GlobalBye', 'Bye.', true),
    L('O', 'GlobalOoops', 'Ooops.', true), L('Q', 'GlobalQuiet', 'Quiet!', true), L('S', 'GlobalShazbot', 'Shazbot!', true), L('W', 'GlobalWoohoo', 'Woohoo!', true),
    N('C', 'Compliment', [
      L('A', 'GlobalComplimentAwesome', 'Awesome!', true), L('G', 'GlobalComplimentGoodGame', 'Good game', true), L('N', 'GlobalComplimentNiceMove', 'Nice move!', true),
      L('Y', 'GlobalComplimentYouRock', 'You Rock!', true), L('S', 'GlobalComplimentGreatShot', 'Great shot!', true),
    ]),
    N('R', 'Respond', [
      L('A', 'GlobalRespondAnyTime', 'Any time.', true), L('D', 'GlobalRespondDontKnow', "I don't know.", true),
      L('T', 'GlobalRespondThanks', 'Thanks.', true), L('W', 'GlobalRespondWait', 'Wait.', true),
    ]),
    N('T', 'Taunt', [
      L('A', 'GlobalTauntAww', "Aww, that's too bad!", true), L('O', 'GlobalTauntObnoxious', 'Is that the best you can do?', true),
      L('B', 'GlobalTauntBrag', 'I am the greatest!', true), L('S', 'GlobalTauntSarcasm', 'THAT was graceful!', true), L('L', 'GlobalTauntLearn', 'When will you learn?', true),
    ]),
  ]),
  N('N', 'Need', [
    L('C', 'NeedCover', 'Need covering fire.'), L('D', 'NeedDriver', 'I need a driver.'), L('E', 'NeedEscort', 'I need an escort.'),
    L('H', 'NeedHoldVehicle', "Hold that vehicle! I'm coming!"), L('R', 'NeedRide', 'I need a ride!'), L('S', 'NeedSupport', 'I need support!'),
    L('V', 'NeedVehicleReady', 'Vehicle ready. Need a ride?'), L('W', 'NeedWhereTo', 'Where to?'),
  ]),
  N('R', 'Repair', [
    L('G', 'RepairGenerator', 'Repair our generator!'), L('S', 'RepairSensors', 'Repair our sensors!'), L('T', 'RepairTurrets', 'Repair our turrets!'), L('V', 'RepairVehicle', 'Repair the vehicle!'),
  ]),
  N('S', 'Self', [
    N('A', 'Attack', [
      L('A', 'SelfAttack', 'I will attack.'), L('B', 'SelfAttackBase', 'I will attack the enemy base.'), L('F', 'SelfAttackFlag', "I'll go for the enemy flag."),
      L('G', 'SelfAttackGenerator', "I'll attack the enemy generator."), L('S', 'SelfAttackSensors', "I'll attack the enemy sensors."),
      L('T', 'SelfAttackTurrets', "I'll attack the enemy turrets."), L('V', 'SelfAttackVehicle', "I'll attack the enemy vehicle."),
      N('P', 'Point', points('SelfAttack', 'attack', true)),
    ]),
    N('D', 'Defend', [
      L('D', 'SelfDefend', 'I will defend.'), L('B', 'SelfDefendBase', 'I will defend our base.'), L('F', 'SelfDefendFlag', 'I will defend our flag.'),
      L('G', 'SelfDefendGenerator', "I'll defend our generator."), L('S', 'SelfDefendSensors', "I'll defend our sensors."),
      L('T', 'SelfDefendTurrets', "I'll defend our turrets."), L('V', 'SelfDefendVehicle', "I'll defend our vehicle."),
      N('P', 'Point', points('SelfDefend', 'defend', true)),
    ]),
    N('R', 'Repair', [
      L('B', 'SelfRepairBase', "I'll repair our base."), L('G', 'SelfRepairGenerator', "I'll repair our generator."), L('S', 'SelfRepairSensors', "I'll repair our sensors."),
      L('T', 'SelfRepairTurrets', "I'll repair our turrets."), L('V', 'SelfRepairVehicle', "I'll repair the vehicle."),
    ]),
    N('T', 'Task', [
      L('C', 'SelfTaskCover', "I'll cover you."), L('D', 'SelfTaskDefenses', "I'll set up defenses."), L('F', 'SelfTaskForcefield', "I'll deploy forcefields."),
      L('O', 'SelfTaskOnIt', "I'm on it."), L('S', 'SelfTaskDeploySensors', "I'm deploying sensors."), L('T', 'SelfTaskDeployTurrets', "I'm deploying turrets."),
      L('V', 'SelfTaskVehicle', "I'll get a vehicle ready."),
    ]),
    N('U', 'Upgrade', [
      L('G', 'SelfUpgradeGenerator', "I'll upgrade our generator."), L('S', 'SelfUpgradeSensors', "I'll upgrade our sensors."), L('T', 'SelfUpgradeTurrets', "I'll upgrade our base turrets."),
    ]),
  ]),
  N('T', 'Target', [
    L('A', 'TargetAcquired', 'Target acquired.'), L('B', 'TargetBase', "Target the enemy base! I'm in position."), L('D', 'TargetDestroyed', 'Target destroyed.'),
    L('F', 'TargetFlag', "Target the enemy flag! I'm in position."), L('M', 'TargetFireOnMy', 'Fire on my target!'), L('N', 'TargetNeed', 'I need a target painted!'),
    L('S', 'TargetSensors', "Target the sensors! I'm in position."), L('T', 'TargetTurret', "Target the turret! I'm in position."),
    L('V', 'TargetVehicle', "Target the vehicle! I'm in position."), L('W', 'TargetWait', "Wait! I'll be in range soon."),
  ]),
  N('U', 'Upgrade', [
    L('G', 'UpgradeGenerator', 'Upgrade our generator!'), L('S', 'UpgradeSensors', 'Upgrade our sensors!'), L('T', 'UpgradeTurrets', 'Upgrade our base turrets!'),
  ]),
  N('W', 'Warning', [L('E', 'WarnEnemies', 'Incoming hostiles!'), L('V', 'WarnVehicle', 'Incoming enemy vehicle!')]),
  N('V', 'Very Quick', [
    L('Y', 'TeamYes', 'Yes.'), L('N', 'TeamNo', 'No.'), L('A', 'TeamAnytime', 'Anytime.'), L('B', 'TeamBaseSecure', 'Is our base secure?'),
    L('C', 'TeamCeaseFire', 'Cease fire!'), L('D', 'TeamDontKnow', "I don't know."), L('H', 'TeamHelp', 'Help!'), L('M', 'TeamMove', 'Move!'),
    L('S', 'TeamSorry', 'Sorry.'), L('T', 'TeamThanks', 'Thanks.'), L('W', 'TeamWait', 'Wait.'),
  ]),
]);

export const VGS_BY_ID: Record<string, VgsLeaf> = {};
(function index(n: VgsNode) {
  for (const c of n.children) {
    if (isVgsNode(c)) index(c);
    else VGS_BY_ID[c.id] = c;
  }
})(VGS_ROOT);

export const VGS_IDS = Object.keys(VGS_BY_ID);
