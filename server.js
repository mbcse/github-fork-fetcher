const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const ExcelJS = require('exceljs');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
const port = 3000;

// Middleware to parse JSON bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from 'public' directory
app.use(express.static('public'));

console.log(process.env.GITHUB_TOKEN)

// Function to escape CSV fields properly
function escapeCSVField(field) {
    if (field === null || field === undefined) {
        return '';
    }
    
    const cleanField = String(field)
        .replace(/\n/g, ' ')
        .replace(/\r/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (cleanField.includes(',') || cleanField.includes('"') || cleanField.includes(' ')) {
        return `"${cleanField.replace(/"/g, '""')}"`;
    }
    
    return cleanField;
}

// Function to extract social media links from text
function extractSocialLinks(text) {
    if (!text) return {};
    
    const socialPatterns = {
        twitter: /(?:twitter\.com\/|x\.com\/|@)([a-zA-Z0-9_]+)/i,
        linkedin: /linkedin\.com\/in\/([a-zA-Z0-9-]+)/i,
        instagram: /instagram\.com\/([a-zA-Z0-9._]+)/i,
        facebook: /facebook\.com\/([a-zA-Z0-9.-]+)/i,
        youtube: /youtube\.com\/@?([a-zA-Z0-9-]+)/i,
        medium: /medium\.com\/@?([a-zA-Z0-9-]+)/i,
    };

    const socials = {};
    for (const [platform, pattern] of Object.entries(socialPatterns)) {
        const match = text.match(pattern);
        if (match) {
            socials[platform] = match[1];
        }
    }
    return socials;
}

// Function to get user's README content
async function getUserReadme(username) {
    try {
        const response = await axios.get(
            `https://api.github.com/repos/${username}/${username}/contents/README.md`,
            {
                headers: {
                    'Accept': 'application/vnd.github.v3.raw',
                    'Authorization': `token ${process.env.GITHUB_TOKEN}`
                }
            }
        );
        console.log(`Fetched README for user: ${username}`);
        return response.data;
    } catch (error) {
        console.error(`Error fetching README for user: ${username}`, error.message);
        return null;
    }
}

// Function to get user details
async function getUserDetails(username) {
    try {
        const response = await axios.get(
            `https://api.github.com/users/${username}`,
            {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'Authorization': `token ${process.env.GITHUB_TOKEN}`
                }
            }
        );
        
        const readme = await getUserReadme(username);
        const bioSocials = extractSocialLinks(response.data.bio || '');
        const blogSocials = extractSocialLinks(response.data.blog || '');
        const readmeSocials = extractSocialLinks(readme || '');
        
        const socials = {
            ...bioSocials,
            ...blogSocials,
            ...readmeSocials
        };

        console.log(`Fetched details for user: ${username}`);
        return {
            ...response.data,
            socials: socials
        };
    } catch (error) {
        console.error(`Error fetching details for user: ${username}`, error.message);
        return null;
    }
}

// Function to process a batch of forks
async function processForkBatch(forks) {
    console.log(`Processing batch of ${forks.length} forks`);
    const userDetailPromises = forks.map(fork => getUserDetails(fork.owner.login));
    const userDetails = await Promise.all(userDetailPromises);
    
    return forks.map((fork, index) => {
        const details = userDetails[index];
        if (!details) return null;
        
        return {
            username: fork.owner.login,
            forkedAt: fork.created_at,
            profileUrl: `https://github.com/${fork.owner.login}`,
            email: details.email || 'Not public',
            bio: details.bio || 'No bio',
            location: details.location || 'Not specified',
            publicRepos: details.public_repos,
            followers: details.followers,
            following: details.following,
            blog: details.blog || 'Not specified',
            twitter: details.socials.twitter ? `https://twitter.com/${details.socials.twitter}` : 'Not found',
            linkedin: details.socials.linkedin ? `https://linkedin.com/in/${details.socials.linkedin}` : 'Not found',
            instagram: details.socials.instagram ? `https://instagram.com/${details.socials.instagram}` : 'Not found',
            facebook: details.socials.facebook ? `https://facebook.com/${details.socials.facebook}` : 'Not found',
            youtube: details.socials.youtube ? `https://youtube.com/${details.socials.youtube}` : 'Not found',
            medium: details.socials.medium ? `https://medium.com/@${details.socials.medium}` : 'Not found'
        };
    }).filter(Boolean);
}

// Function to get all forks for a repository
async function getForks(owner, repo) {
    const allForks = [];
    let page = 1;
    const perPage = 100;
    
    try {
        while (true) {
            console.log(`Fetching forks for ${owner}/${repo}, page ${page}`);
            const response = await axios.get(
                `https://api.github.com/repos/${owner}/${repo}/forks`,
                {
                    params: {
                        page: page,
                        per_page: perPage
                    },
                    headers: {
                        'Accept': 'application/vnd.github.v3+json',
                        'Authorization': `token ${process.env.GITHUB_TOKEN}`
                    }
                }
            );

            const forksData = response.data;
            
            if (forksData.length === 0) {
                break;
            }

            const processedForks = await processForkBatch(forksData);
            allForks.push(...processedForks);
            
            page += 1;

            if (forksData.length < perPage) {
                break;
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(`Fetched total ${allForks.length} forks for ${owner}/${repo}`);
        return allForks;
    } catch (error) {
        console.error(`Error fetching forks for ${owner}/${repo}`, error.message);
        throw error;
    }
}

// Function to generate Excel file
async function generateExcel(forks) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Fork Details');

    worksheet.columns = [
        { header: 'Username', key: 'username', width: 20 },
        { header: 'Profile URL', key: 'profileUrl', width: 30 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Location', key: 'location', width: 20 },
        { header: 'Fork Date', key: 'forkedAt', width: 20 },
        { header: 'Bio', key: 'bio', width: 40 },
        { header: 'Public Repos', key: 'publicRepos', width: 15 },
        { header: 'Followers', key: 'followers', width: 15 },
        { header: 'Following', key: 'following', width: 15 },
        { header: 'Blog', key: 'blog', width: 30 },
        { header: 'Twitter', key: 'twitter', width: 30 },
        { header: 'LinkedIn', key: 'linkedin', width: 30 },
        { header: 'Instagram', key: 'instagram', width: 30 },
        { header: 'Facebook', key: 'facebook', width: 30 },
        { header: 'YouTube', key: 'youtube', width: 30 },
        { header: 'Medium', key: 'medium', width: 30 }
    ];

    worksheet.addRows(forks);

    const filePath = path.join(__dirname, 'public', 'downloads', 'fork_details.xlsx');
    await workbook.xlsx.writeFile(filePath);
    console.log(`Excel file generated at ${filePath}`);
    return '/downloads/fork_details.xlsx';
}

// Route to serve the HTML form
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route to process repository URL and generate Excel file
app.post('/analyze', async (req, res) => {
    try {
        const repoUrl = req.body.repoUrl;
        const [, , , owner, repo] = repoUrl.split('/');

        console.log(`Analyzing repository: ${repoUrl}`);

        const forks = await getForks(owner, repo);
        const downloadPath = await generateExcel(forks);

        res.json({ 
            success: true, 
            downloadUrl: downloadPath,
            message: `Successfully analyzed ${forks.length} forks`
        });
    } catch (error) {
        console.error(`Error analyzing repository: ${error.message}`);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Create downloads directory if it doesn't exist
const downloadDir = path.join(__dirname, 'public', 'downloads');
fs.mkdir(downloadDir, { recursive: true }).catch(console.error);

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});