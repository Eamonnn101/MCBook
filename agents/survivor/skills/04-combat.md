# Skill: Combat

## Trigger
Hostile mob detected in scan, or under attack.

## Pre-Combat Checklist
1. Equip best weapon (stone_sword > wooden_sword)
2. Check HP — if < 6, consider fleeing instead
3. Eat food if HP < 10 and you have food

## Per-Mob Strategy

### zombie
- **Action**: Stand and fight
- **Notes**: Slow, easy target. Good XP. May drop iron ingot rarely.
```json
{ "tool": "equip", "args": { "item_name": "stone_sword" }, "note": "arm up" },
{ "tool": "attack", "args": { "target_name": "zombie" }, "note": "kill zombie" }
```

### skeleton
- **Action**: Close distance fast, then attack
- **Notes**: Dangerous at range (shoots arrows). Rush in with move_to if distant.
```json
{ "tool": "equip", "args": { "item_name": "stone_sword" }, "note": "arm up" },
{ "tool": "attack", "args": { "target_name": "skeleton" }, "note": "rush and kill" }
```

### spider
- **Action**: Attack normally
- **Notes**: Neutral during day, hostile at night. Can climb walls.
```json
{ "tool": "attack", "args": { "target_name": "spider" }, "note": "kill spider" }
```

### creeper
- **Action**: **FLEE IMMEDIATELY!**
- **Notes**: Explodes on contact. Destroys blocks. NEVER melee.
```json
{ "tool": "move_to", "args": { "x": <opposite_x>, "y": <y>, "z": <opposite_z> }, "note": "RUN from creeper!" }
```
Move at least 10-15 blocks away from the creeper's position.

### enderman
- **Action**: **DO NOT ENGAGE**
- **Notes**: Very dangerous if provoked. Ignore completely.

### witch
- **Action**: Flee if low HP, fight if healthy + armed
- **Notes**: Throws potions. Dangerous without good gear.

## Example Plan (under attack by zombie)
```json
{
  "reflection": "Zombie attacking me. HP at 14, I have a sword. Will fight.",
  "plan": [
    { "tool": "equip", "args": { "item_name": "stone_sword" }, "note": "ready weapon" },
    { "tool": "attack", "args": { "target_name": "zombie" }, "note": "kill the zombie" },
    { "tool": "eat", "args": {}, "note": "heal up after combat" }
  ]
}
```

## Tips
- Local rules auto-equip weapon on damage — but explicitly equip best weapon anyway
- After combat, always eat to restore HP
- Multiple mobs? Kill one at a time, eat between fights if needed
- No weapon? Flee with move_to, then craft one ASAP
