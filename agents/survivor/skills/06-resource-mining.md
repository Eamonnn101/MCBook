# Skill: Resource Mining

## Trigger
Have tools, safe conditions, need resources.

## Resource Priority
1. **coal_ore** — common, useful (drops coal for torches if we could craft them)
2. **iron_ore** — valuable, but cannot smelt without furnace tool
3. **stone** — always useful for tools and building
4. **oak_log** — essential for planks, sticks, crafting table

## Mining Requirements
| Resource | Required Tool |
|----------|--------------|
| stone | wooden_pickaxe or better |
| coal_ore | wooden_pickaxe or better |
| iron_ore | stone_pickaxe or better |
| diamond_ore | iron_pickaxe (NOT AVAILABLE — stone won't work) |
| dirt/sand/gravel | any tool or bare hands |
| oak_log | any tool or bare hands (axe is faster) |

## Example Plan (resource gathering)
```json
{
  "reflection": "Safe and equipped. Time to gather resources for the future.",
  "plan": [
    { "tool": "equip", "args": { "item_name": "stone_pickaxe" }, "note": "best mining tool" },
    { "tool": "mine", "args": { "block_type": "coal_ore" }, "note": "gather coal" },
    { "tool": "mine", "args": { "block_type": "coal_ore" }, "note": "more coal" },
    { "tool": "mine", "args": { "block_type": "iron_ore" }, "note": "gather iron ore" },
    { "tool": "mine", "args": { "block_type": "stone" }, "note": "cobblestone for spare tools" }
  ]
}
```

## Tips
- Always equip the right pickaxe before mining ores
- Keep cobblestone stocked for replacement tools
- If pickaxe breaks mid-mining, craft a new one before continuing
- Mine blocks visible in your scan — don't move_to far away just for ores
- iron_ore is useful to stockpile even without smelting (future capability)
