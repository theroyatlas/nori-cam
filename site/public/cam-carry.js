// Presentation only: a placed snapshot may still be in flight on the timeline.
// Resolve one identity for both the mouth layer and floor/contact-shadow layers.
export function carryPresentation(objects, segments, time) {
  const active = (segments || []).filter(s => time >= s.start_at &&
    time < Math.min(s.end_at, s.cut_at ?? Infinity, s.superseded_at ?? Infinity))
    .sort((a,b) => b.start_at-a.start_at || b.id-a.id)[0];
  const id = active?.carrying || (active?.primitive === 'carry' ? active.target : null);
  const carried = id ? objects.find(o => o.id === id && (!o.status || ['placed','carried'].includes(o.status)))
    : objects.find(o => o.status === 'carried');
  return {carried: carried || null, floorObjects: carried ? objects.filter(o => o.id !== carried.id) : objects};
}
