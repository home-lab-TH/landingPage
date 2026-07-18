export type Site = { title: string; description: string; url: string; icon: string; badge: string };
export type UserSection = { name: string; role: string; avatar: string; sites: Site[] };

export const dashboardConfig = {
  userSections: [
    { name: 'Alex Morgan', role: 'Builder', avatar: 'https://api.dicebear.com/9.x/notionists/svg?seed=Alex&backgroundColor=0f172a', sites: [
      { title: 'Media Vault', description: 'Films, shows, and weekend finds.', url: 'https://example.com', icon: 'MV', badge: 'Jellyfin' },
      { title: 'Photo Archive', description: 'A private, self-hosted photo library.', url: 'https://example.com', icon: 'PA', badge: 'Immich' },
      { title: 'Alex Notes', description: 'Thoughts, docs, and useful snippets.', url: 'https://example.com', icon: 'AN', badge: 'Docs' },
    ] },
    { name: 'Samira Cole', role: 'Maker', avatar: 'https://api.dicebear.com/9.x/notionists/svg?seed=Samira&backgroundColor=172554', sites: [
      { title: 'Recipe Shelf', description: 'A growing collection of reliable meals.', url: 'https://example.com', icon: 'RS', badge: 'Personal' },
      { title: 'Studio Queue', description: 'Current illustrations and commissions.', url: 'https://example.com', icon: 'SQ', badge: 'Creative' },
      { title: 'Reading Room', description: 'Bookmarks, highlights, and newsletters.', url: 'https://example.com', icon: 'RR', badge: 'Library' },
    ] },
    { name: 'Jordan Lee', role: 'Tinkerer', avatar: 'https://api.dicebear.com/9.x/notionists/svg?seed=Jordan&backgroundColor=042f2e', sites: [
      { title: 'Home Control', description: 'Lights, climate, and automation.', url: 'https://example.com', icon: 'HC', badge: 'Home Assistant' },
      { title: 'Game Server', description: 'Friends-only worlds, always ready.', url: 'https://example.com', icon: 'GS', badge: 'Online' },
      { title: 'Wireguard', description: 'Secure access to the home network.', url: 'https://example.com', icon: 'WG', badge: 'Network' },
    ] },
  ] satisfies UserSection[],
  sharedProjects: [
    { title: 'Workshop Wiki', status: 'Online', description: 'The shared source of truth for setup notes, plans, and hard-won lessons.', url: 'https://example.com', icon: 'WW', stack: ['Outline', 'Postgres', 'Docker'] },
    { title: 'Little Signal', status: 'In Development', description: 'A simple family check-in board made for the people we care about.', url: 'https://example.com', icon: 'LS', stack: ['Next.js', 'Supabase', 'Vercel'] },
    { title: 'Cloud Shelf', status: 'Online', description: 'Our shared storage space for projects, assets, and large files.', url: 'https://example.com', icon: 'CS', stack: ['Nextcloud', 'Redis', 'Traefik'] },
    { title: 'Friday Radio', status: 'In Development', description: 'Collaborative playlists and a small broadcast station for the weekend.', url: 'https://example.com', icon: 'FR', stack: ['React', 'Node.js', 'Icecast'] },
  ],
};
