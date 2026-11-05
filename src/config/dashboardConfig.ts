// Edit this file to change friends, their services, and shared projects.
export type Site = { title: string; description: string; url: string; icon: string; badge: string };
export type UserSection = { name: string; role: string; avatar: string; sites: Site[] };

export const dashboardConfig = {
  userSections: [
    { name: 'Alex Morgan', role: 'Builder', avatar: './avatars/alex.svg', sites: [
      { title: 'Media Vault', description: 'Films, shows, and weekend finds.', url: './jellyfin', icon: 'MV', badge: 'Jellyfin' },
      { title: 'Photo Archive', description: 'A private, self-hosted photo library.', url: './immich', icon: 'PA', badge: 'Immich' },
      { title: 'Alex Notes', description: 'Thoughts, docs, and useful snippets.', url: './notes', icon: 'AN', badge: 'Docs' },
    ] },
    { name: 'Samira Cole', role: 'Maker', avatar: './avatars/samira.svg', sites: [
      { title: 'Recipe Shelf', description: 'A growing collection of reliable meals.', url: './recipes', icon: 'RS', badge: 'Personal' },
      { title: 'Studio Queue', description: 'Current illustrations and commissions.', url: './studio', icon: 'SQ', badge: 'Creative' },
      { title: 'Reading Room', description: 'Bookmarks, highlights, and newsletters.', url: './reading', icon: 'RR', badge: 'Library' },
    ] },
    { name: 'Jordan Lee', role: 'Tinkerer', avatar: './avatars/jordan.svg', sites: [
      { title: 'Home Control', description: 'Lights, climate, and automation.', url: './home', icon: 'HC', badge: 'Home Assistant' },
      { title: 'Game Server', description: 'Friends-only worlds, always ready.', url: './games', icon: 'GS', badge: 'Online' },
      { title: 'Wireguard', description: 'Secure access to the home network.', url: './wireguard', icon: 'WG', badge: 'Network' },
    ] },
  ] satisfies UserSection[],
  sharedProjects: [
    { title: 'CodeZi', status: 'Online', description: 'Real-time poker, games and leaderboards.', url: './codezi/', icon: 'CZ', stack: ['React', 'Node.js', 'Socket.io', 'MongoDB'] },
    { title: 'Flight Monitor', status: 'Online', description: 'Flight price tracking (shachar_b).', url: './docker-avi/', icon: 'FM', stack: ['React', 'Express', 'MongoDB', 'Docker'] },
    { title: "Jacob's Flight Monitor", status: 'Online', description: "Jacob's flight app.", url: './jacobFlightMonitor/', icon: 'JF', stack: ['React', 'Express', 'Docker'] },
  ],
};
