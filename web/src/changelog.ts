// Player-facing changelog for PZ Survivor Studio, shown in the Help popout. Newest entry first.
// To add a release: prepend an entry. Keep it short and user-facing (no internal/dev detail).
export type ChangelogEntry = { date?: string; title: string; items: string[] };

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: '2026-07-23',
    title: 'Body attachments, faithful layering & fixes',
    items: [
      'Attach weapons and gear to the body: sling a weapon on your back or belt, holster a pistol, clip a light onto webbing. Placement follows the game’s own rules and locations (a bat can’t go on a belt; a holster has to be worn before a gun goes in it).',
      'Clothing textures now stack in Project Zomboid’s real layer order (socks under longjohns under shoes, tank top under t-shirt under shirt…) no matter which order you put them on.',
      'Modular weapons that pack several parts into one model file now show the correct part.',
      'Saving or loading a character now keeps everything: worn clothing, held items, body attachments and the full scene setup.',
      'Animation loop fixes: turning loop off now plays a clip once and stops, with a new replay button to play it again.',
      'Polish for the equipment and attachment menus on mobile.',
    ],
  },
  {
    title: 'PZ Survivor Studio',
    items: [
      'Dress and pose Project Zomboid survivors: clothing, held items, hair, beards and skin tones.',
      'Play any in-game animation, scrub frame by frame, and set the camera, lighting, floor and background.',
      'Export your survivor as a PNG, a looping GIF or an MP4.',
      'Optional account to share your survivors, plus item names in many languages.',
      'Runs from the built-in asset library or from your own installed game files.',
    ],
  },
];
