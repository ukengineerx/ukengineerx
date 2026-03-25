const fs = require('fs');
const axios = require('axios');
const moment = require('moment');

const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'ukengineerx';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const api = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json'
  }
});

async function fetchUserStats() {
  try {
    const userRes = await api.get(`/users/${GITHUB_USERNAME}`);
    const user = userRes.data;

    // Fetch all repos (paginated)
    let repos = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const reposRes = await api.get(`/users/${GITHUB_USERNAME}/repos`, {
        params: { per_page: 100, page, sort: 'updated' }
      });
      repos = repos.concat(reposRes.data);
      hasMore = reposRes.data.length === 100;
      page++;
    }

    // Aggregate stats
    let totalCommits = 0;
    let totalLOC = 0;
    const languageMap = {};
    const projectMetrics = [];
    const monthlyActivity = {};

    // Initialize last 6 months
    for (let i = 0; i < 6; i++) {
      const month = moment().subtract(i, 'months').format('YYYY-MM');
      monthlyActivity[month] = { commits: 0, prs: 0, issues: 0 };
    }

    // Process each repo
    for (const repo of repos.slice(0, 50)) {
      try {
        // Get languages
        const langRes = await api.get(`/repos/${GITHUB_USERNAME}/${repo.name}/languages`);
        const languages = langRes.data;
        let repoLOC = 0;
        for (const [lang, bytes] of Object.entries(languages)) {
          languageMap[lang] = (languageMap[lang] || 0) + bytes;
          repoLOC += bytes;
          totalLOC += bytes;
        }

        // Get commits for this repo
        const commitsRes = await api.get(`/repos/${GITHUB_USERNAME}/${repo.name}/commits`, {
          params: { per_page: 1 }
        });
        const commitCount = commitsRes.headers['link']
          ? parseInt(commitsRes.headers['link'].match(/page=(\d+)>; rel="last"/)?.[1] || '1')
          : (commitsRes.data.length || 0);
        
        totalCommits += commitCount;

        // Get recent activity (last 6 months)
        const sixMonthsAgo = moment().subtract(6, 'months').toISOString();
        const commitHistory = await api.get(
          `/repos/${GITHUB_USERNAME}/${repo.name}/commits`,
          { params: { since: sixMonthsAgo, per_page: 100 } }
        );

        for (const commit of commitHistory.data) {
          const month = moment(commit.commit.author.date).format('YYYY-MM');
          if (monthlyActivity[month]) {
            monthlyActivity[month].commits += 1;
          }
        }

        // Store project metrics
        projectMetrics.push({
          name: repo.name,
          status: repo.archived ? 'Archived' : 'Active',
          loc: repoLOC,
          updated: moment(repo.updated_at).format('MMM YYYY'),
          url: repo.html_url
        });

      } catch (e) {
        console.log(`Skipped ${repo.name}: ${e.message}`);
      }
    }

    // Sort languages by bytes
    const topLanguages = Object.entries(languageMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 7);

    const totalLangBytes = Object.values(languageMap).reduce((a, b) => a + b, 0);

    return {
      user: {
        publicRepos: user.public_repos,
        followers: user.followers,
        name: user.name || GITHUB_USERNAME
      },
      stats: {
        totalCommits,
        totalLOC,
        publicRepos: repos.length,
        followers: user.followers
      },
      languages: topLanguages.map(([lang, bytes]) => ({
        lang,
        bytes,
        percentage: Math.round((bytes / totalLangBytes) * 100)
      })),
      projects: projectMetrics.sort((a, b) => b.loc - a.loc).slice(0, 5),
      monthlyActivity: monthlyActivity
    };
  } catch (error) {
    console.error('Error fetching stats:', error.message);
    throw error;
  }
}

function generateAnalyticsSections(data) {
  // Contribution Activity Table
  const contributionTable = `| Metric | Value |
|--------|-------|
| **Total Commits** | ${data.stats.totalCommits.toLocaleString()}+ |
| **Public Repos** | ${data.stats.publicRepos} |
| **Followers** | ${data.stats.followers}+ |
| **Total Lines of Code** | ${Math.round(data.stats.totalLOC / 1000)}K+ |`;

  // Language Distribution Table
  const languageTable = `| Language | Projects | % of Work |
|----------|----------|-----------|
${data.languages.map(l => `| **${l.lang}** | - | ${l.percentage}% |`).join('\n')}`;

  // Project Metrics Table
  const projectTable = `| Project | Status | Lines of Code | Last Updated |
|---------|--------|----------------|--------------|
${data.projects.map(p => `| [${p.name}](${p.url}) | ${p.status} | ${Math.round(p.loc / 1000)}K+ | ${p.updated} |`).join('\n')}`;

  // Monthly Activity Table (last 6 months)
  const sortedMonths = Object.keys(data.monthlyActivity).sort().reverse();
  const monthlyTable = `| Month | Commits |
|-------|---------|
${sortedMonths.map(m => `| **${m}** | ${data.monthlyActivity[m].commits} |`).join('\n')}`;

  return { contributionTable, languageTable, projectTable, monthlyTable };
}

function updateReadme(analyticsData) {
  let readme = fs.readFileSync('README.md', 'utf-8');

  const { contributionTable, languageTable, projectTable, monthlyTable } = generateAnalyticsSections(analyticsData);

  // Replace or insert contribution activity
  const contributionPattern = /### Contribution Activity\n\n\|[\s\S]*?\n(?=\n###|\n##|$)/;
  readme = readme.replace(
    contributionPattern,
    `### Contribution Activity\n\n${contributionTable}\n`
  );

  // Replace or insert language distribution
  const languagePattern = /### Language Distribution\n\n\|[\s\S]*?\n(?=\n###|\n##|$)/;
  readme = readme.replace(
    languagePattern,
    `### Language Distribution\n\n${languageTable}\n`
  );

  // Replace or insert project metrics
  const projectPattern = /### Project Metrics\n\n\|[\s\S]*?\n(?=\n###|\n##|$)/;
  readme = readme.replace(
    projectPattern,
    `### Project Metrics\n\n${projectTable}\n`
  );

  // Replace or insert monthly activity
  const monthlyPattern = /### Monthly Activity \(Last 6 Months\)\n\n\|[\s\S]*?\n(?=\n###|\n##|$)/;
  readme = readme.replace(
    monthlyPattern,
    `### Monthly Activity (Last 6 Months)\n\n${monthlyTable}\n`
  );

  // Add Last Updated timestamp
  const timestamp = moment().format('MMMM DD, YYYY [at] HH:mm UTC');
  const footerPattern = /^Last updated: .*$/m;
  if (footerPattern.test(readme)) {
    readme = readme.replace(footerPattern, `Last updated: ${timestamp}`);
  } else {
    readme += `\n\n---\n\nLast updated: ${timestamp}`;
  }

  fs.writeFileSync('README.md', readme);
  console.log('✓ README.md updated with live stats');
}

async function main() {
  try {
    console.log(`Fetching stats for @${GITHUB_USERNAME}...`);
    const data = await fetchUserStats();
    updateReadme(data);
    console.log('✓ Done!');
  } catch (error) {
    console.error('✗ Failed to update README:', error.message);
    process.exit(1);
  }
}

main();
