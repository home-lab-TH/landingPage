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
    { title: 'Workshop Wiki', status: 'Online', description: 'The shared source of truth for setup notes, plans, and hard-won lessons.', url: './wiki', icon: 'WW', stack: ['Outline', 'Postgres', 'Docker'] },
    { title: 'Little Signal', status: 'In Development', description: 'A simple family check-in board made for the people we care about.', url: './signal', icon: 'LS', stack: ['Next.js', 'Supabase', 'Vercel'] },
    { title: 'Cloud Shelf', status: 'Online', description: 'Our shared storage space for projects, assets, and large files.', url: './cloud', icon: 'CS', stack: ['Nextcloud', 'Redis', 'Traefik'] },
    { title: 'Friday Radio', status: 'In Development', description: 'Collaborative playlists and a small broadcast station for the weekend.', url: './radio', icon: 'FR', stack: ['React', 'Node.js', 'Icecast'] },
  ],
};
