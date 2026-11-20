const REPO = 'https://github.com/kartalkral/aevum-rts';

// Only a full commit ID can change the destination; request data never does.
export function sourceLink(env) {
  const commit = [env.RENDER_GIT_COMMIT, env.KARTAL_SOURCE_COMMIT].find(value => /^[0-9a-f]{40}$/i.test(value || ''));
  return { url: commit ? `${REPO}/tree/${commit.toLowerCase()}` : REPO, pinned: !!commit };
}
