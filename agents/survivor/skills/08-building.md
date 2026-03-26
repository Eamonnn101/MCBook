# Skill: Building a Shelter

## Trigger
You have 10+ logs OR 20+ dirt/cobblestone in inventory AND no shelter built yet.

## IMPORTANT RULE
**Do NOT keep gathering resources forever!** Once you have enough materials for a basic shelter (10 logs or 20 dirt), STOP gathering and START building immediately. A simple dirt/log hut is far better than dying at night with a full inventory.

## Material Requirements (minimal shelter)
- **Dirt hut**: ~20 dirt blocks (free, just dig nearby)
- **Log cabin**: ~10 logs (from 2-3 trees, already gives 10+ logs)
- **Cobblestone house**: ~30 cobblestone (from mining stone)

You do NOT need stone tools, iron, or anything fancy. Build with whatever you have RIGHT NOW.

## Building Steps (5x5x3 box)
Pick a flat area near your current position. Build walls 3 blocks high.

### Phase 1: Foundation (place floor corners to mark the area)
Use your current position as reference. Place 4 corner pillars:
- Corner 1: (x, y, z)
- Corner 2: (x+4, y, z)
- Corner 3: (x, y, z+4)
- Corner 4: (x+4, y, z+4)

### Phase 2: Walls
Fill in walls between corners, 3 blocks high. Leave one gap for a door.

### Phase 3: Roof
Place blocks on top to cover the shelter.

## Example Plan (dirt shelter)
```json
{
  "reflection": "I have enough logs. Time to build a shelter before night comes.",
  "plan": [
    { "tool": "mine", "args": { "block_type": "dirt" }, "note": "gather dirt for walls" },
    { "tool": "mine", "args": { "block_type": "dirt" }, "note": "more dirt" },
    { "tool": "place", "args": { "block_name": "dirt", "x": 100, "y": 64, "z": 200 }, "note": "first wall block" },
    { "tool": "place", "args": { "block_name": "dirt", "x": 101, "y": 64, "z": 200 }, "note": "wall continues" },
    { "tool": "place", "args": { "block_name": "dirt", "x": 102, "y": 64, "z": 200 }, "note": "wall continues" },
    { "tool": "place", "args": { "block_name": "dirt", "x": 100, "y": 65, "z": 200 }, "note": "second layer" },
    { "tool": "place", "args": { "block_name": "dirt", "x": 101, "y": 65, "z": 200 }, "note": "second layer" },
    { "tool": "place", "args": { "block_name": "dirt", "x": 102, "y": 65, "z": 200 }, "note": "second layer" }
  ]
}
```

## Example Plan (log cabin)
```json
{
  "reflection": "I have 12 oak_log from chopping trees. Building a log cabin now.",
  "plan": [
    { "tool": "craft", "args": { "item_name": "oak_planks", "count": 3 }, "note": "logs to planks for building" },
    { "tool": "place", "args": { "block_name": "oak_planks", "x": 100, "y": 64, "z": 200 }, "note": "cabin wall" },
    { "tool": "place", "args": { "block_name": "oak_planks", "x": 101, "y": 64, "z": 200 }, "note": "cabin wall" },
    { "tool": "place", "args": { "block_name": "oak_planks", "x": 102, "y": 64, "z": 200 }, "note": "cabin wall" },
    { "tool": "place", "args": { "block_name": "oak_planks", "x": 100, "y": 65, "z": 200 }, "note": "second layer" },
    { "tool": "place", "args": { "block_name": "oak_planks", "x": 101, "y": 65, "z": 200 }, "note": "second layer" },
    { "tool": "place", "args": { "block_name": "oak_planks", "x": 102, "y": 65, "z": 200 }, "note": "second layer" }
  ]
}
```

## Tips
- Use `get_position` to know your current coordinates, then plan `place` commands relative to that
- Build walls in a systematic pattern: one wall at a time, bottom to top
- Leave a 1-block gap on one wall for the door (don't place a block there)
- The `place` tool needs an adjacent solid block to attach to — build from ground up
- Roof: place blocks at y+3 spanning the whole top
- You can use ANY solid block: dirt, oak_log, oak_planks, cobblestone — whatever you have most of
- **A ugly dirt hut keeps you alive. A beautiful house you never started building does not.**
