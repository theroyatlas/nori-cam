# Deterministic physics

`simulatePush({object, world, velocity: [vx, vy], dropHeight256?})` runs in the Worker at planning time.
Velocity components are integer cells/second, clamped to +/-15. Height is 0..2048 in 1/256 cells above the floor.
The object must be a legally placed floor object with `card.space.movable.push` or the `pushable` tag.
The catalog currently marks only the slipper pushable; no catalog ball exists, so rolling is unsupported.
Each 1/60 s step uses integer 1/256-cell positions and velocities; friction subtracts 2 units/step.
Gravity is 2 units/step² and floor restitution is 3/5, truncated; small bounces stop.
Swept footprint boxes stop at walls or blocking floor cells, without transferring momentum.
Movement is limited to one cell Manhattan distance, matching the existing executor effect contract.
Final placement uses `placementOk`; if needed the emitted path is retraced before snapping to a legal cell.
Frames are relative milliseconds, quantized to 1/16 cell; contacts and the final frame may be closer than 50 ms.
The returned effect has relative `at_ms` and `dx`/`dy`; attach it to a normally completed segment.
A2 must store/interpolate the frames and offset their timestamps by the segment start; handle rejected inputs.
No rotation, rolling, stacking, airborne obstacle clearance, or object-to-object momentum is modeled.
