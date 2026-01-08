require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('youtube-dl-exec');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ================= CONFIGURATION =================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key-change-in-production';

// Configuration Cloudflare R2
const s3Client = new S3Client({
  region: process.env.STORAGE_REGION || 'auto',
  endpoint: process.env.STORAGE_ENDPOINT,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY,
    secretAccessKey: process.env.STORAGE_SECRET_KEY,
  },
  forcePathStyle: true,
});

// ================= BASE DE DONNÉES SIMPLE (Fichiers JSON) =================
const DB_DIR = './data';
const USERS_FILE = path.join(DB_DIR, 'users.json');
const JOBS_FILE = path.join(DB_DIR, 'jobs.json');

// Initialiser la base de données
async function initDB() {
  await fs.mkdir(DB_DIR, { recursive: true });
  
  try {
    await fs.access(USERS_FILE);
  } catch {
    await fs.writeFile(USERS_FILE, JSON.stringify([]));
  }
  
  try {
    await fs.access(JOBS_FILE);
  } catch {
    await fs.writeFile(JOBS_FILE, JSON.stringify([]));
  }
}

// Fonctions DB
async function readUsers() {
  const data = await fs.readFile(USERS_FILE, 'utf8');
  return JSON.parse(data);
}

async function writeUsers(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

async function readJobs() {
  const data = await fs.readFile(JOBS_FILE, 'utf8');
  return JSON.parse(data);
}

async function writeJobs(jobs) {
  await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

// ================= MIDDLEWARE =================
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) throw new Error('No token');
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const users = await readUsers();
    const user = users.find(u => u.id === decoded.userId);
    
    if (!user) throw new Error('User not found');
    
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ 
      success: false, 
      error: 'Authentication required' 
    });
  }
};

// ================= ROUTES API =================

// 1. HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'shorts-generator',
    timestamp: new Date().toISOString()
  });
});

// 2. INSCRIPTION
app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const users = await readUsers();
    
    // Vérifier si email existe
    if (users.some(u => u.email === email)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email already registered' 
      });
    }
    
    // Créer utilisateur
    const userId = 'user_' + Date.now();
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const newUser = {
      id: userId,
      email,
      password: hashedPassword,
      credits: 100, // Crédits offerts
      createdAt: new Date().toISOString()
    };
    
    users.push(newUser);
    await writeUsers(users);
    
    // Générer token
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({
      success: true,
      token,
      user: { id: userId, email, credits: 100 }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. CONNEXION
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const users = await readUsers();
    const user = users.find(u => u.email === email);
    
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }
    
    // Vérifier mot de passe
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }
    
    // Générer token
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, credits: user.credits }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. PRÉVISUALISATION
app.post('/api/preview', authMiddleware, async (req, res) => {
  try {
    const { youtubeUrl } = req.body;
    
    if (!youtubeUrl || !youtubeUrl.includes('youtu')) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL YouTube invalide' 
      });
    }
    
    // Obtenir infos vidéo
    let videoInfo;
    try {
      videoInfo = await exec(youtubeUrl, {
        dumpJson: true,
        noWarnings: true
      });
    } catch (error) {
      videoInfo = { title: 'YouTube Video', duration: 300 };
    }
    
    // Toujours 5 shorts (meilleurs moments)
    const totalCost = 25; // 5 shorts × 5 crédits
    const canAfford = req.user.credits >= totalCost;
    
    res.json({
      success: true,
      data: {
        videoTitle: videoInfo.title || 'YouTube Video',
        videoDuration: videoInfo.duration || 300,
        shortsCount: 5,
        totalCost,
        userCredits: req.user.credits,
        canAfford,
        estimatedTime: 120 // 2 minutes estimé
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. CRÉATION DE JOB (5 shorts automatiques)
app.post('/api/jobs', authMiddleware, async (req, res) => {
  try {
    const { youtubeUrl } = req.body;
    const totalCost = 25; // 5 shorts × 5 crédits
    
    // Vérifier crédits
    if (req.user.credits < totalCost) {
      return res.status(402).json({ 
        success: false, 
        error: `Crédits insuffisants. Nécessaire: ${totalCost}, Disponible: ${req.user.credits}` 
      });
    }
    
    // Obtenir infos vidéo
    let videoInfo;
    try {
      videoInfo = await exec(youtubeUrl, {
        dumpJson: true,
        noWarnings: true
      });
    } catch (error) {
      videoInfo = { title: 'YouTube Video', duration: 300 };
    }
    
    // Créer job
    const jobId = 'job_' + Date.now();
    const job = {
      id: jobId,
      userId: req.user.id,
      userEmail: req.user.email,
      youtubeUrl,
      videoTitle: videoInfo.title || 'YouTube Video',
      videoDuration: videoInfo.duration || 300,
      status: 'pending',
      creditsUsed: totalCost,
      shortsCount: 5,
      segments: [],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    };
    
    // Sauvegarder job
    const jobs = await readJobs();
    jobs.push(job);
    await writeJobs(jobs);
    
    // Dédire crédits
    const users = await readUsers();
    const userIndex = users.findIndex(u => u.id === req.user.id);
    if (userIndex !== -1) {
      users[userIndex].credits -= totalCost;
      await writeUsers(users);
    }
    
    // Traitement en arrière-plan
    processJobInBackground(job);
    
    res.json({
      success: true,
      data: {
        jobId,
        status: 'pending',
        creditsUsed: totalCost,
        remainingCredits: req.user.credits - totalCost,
        message: 'Traitement des 5 shorts démarré'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. LISTE DES JOBS
app.get('/api/jobs', authMiddleware, async (req, res) => {
  try {
    const jobs = await readJobs();
    const userJobs = jobs
      .filter(job => job.userId === req.user.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 20);
    
    res.json({
      success: true,
      data: { jobs: userJobs }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. DÉTAILS JOB
app.get('/api/jobs/:id', authMiddleware, async (req, res) => {
  try {
    const jobs = await readJobs();
    const job = jobs.find(j => j.id === req.params.id && j.userId === req.user.id);
    
    if (!job) {
      return res.status(404).json({ 
        success: false, 
        error: 'Job non trouvé' 
      });
    }
    
    // Générer URLs signées si job complété
    if (job.status === 'completed' && job.segments.length > 0) {
      const segmentsWithUrls = await Promise.all(
        job.segments.map(async (segment) => {
          try {
            const previewUrl = await getSignedStorageUrl(segment.storageKey, 7 * 24 * 60 * 60);
            const downloadUrl = await getSignedStorageUrl(segment.storageKey, 24 * 60 * 60);
            
            return {
              ...segment,
              previewUrl,
              downloadUrl,
              shareUrls: {
                tiktok: `tiktok://upload?video_url=${encodeURIComponent(downloadUrl)}`,
                instagram: `instagram://library?AssetPath=${encodeURIComponent(downloadUrl)}`
              }
            };
          } catch (error) {
            return segment;
          }
        })
      );
      
      job.segments = segmentsWithUrls;
    }
    
    // Calculer jours restants
    const expiresAt = new Date(job.expiresAt);
    const now = new Date();
    const daysRemaining = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
    
    res.json({
      success: true,
      data: { 
        job,
        expiresIn: daysRemaining > 0 ? daysRemaining : 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================= FONCTIONS UTILITAIRES =================
async function getSignedStorageUrl(key, expiresIn = 604800) {
  const command = new GetObjectCommand({
    Bucket: process.env.STORAGE_BUCKET,
    Key: key
  });
  return await getSignedUrl(s3Client, command, { expiresIn });
}

async function uploadToStorage(filePath, key, contentType) {
  const fileBuffer = await fs.readFile(filePath);
  
  const command = new PutObjectCommand({
    Bucket: process.env.STORAGE_BUCKET,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
    ACL: 'private'
  });
  
  await s3Client.send(command);
  return key;
}

// ================= TRAITEMENT VIDÉO =================
async function processJobInBackground(job) {
  let tempDir;
  
  try {
    console.log(`Processing job ${job.id} for ${job.userEmail}`);
    
    // Mettre à jour statut
    const jobs = await readJobs();
    const jobIndex = jobs.findIndex(j => j.id === job.id);
    if (jobIndex !== -1) {
      jobs[jobIndex].status = 'processing';
      await writeJobs(jobs);
    }
    
    // Créer dossier temporaire
    tempDir = path.join('/tmp', `shorts_${job.id}_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    const sourceVideo = path.join(tempDir, 'source.mp4');
    const outputDir = path.join(tempDir, 'segments');
    await fs.mkdir(outputDir, { recursive: true });
    
    // 1. Télécharger vidéo YouTube
    console.log('Downloading YouTube video...');
    await exec(job.youtubeUrl, {
      output: sourceVideo,
      format: 'best[ext=mp4]/best',
      noWarnings: true
    });
    
    // 2. Obtenir durée et découper en 5 parties égales
    const duration = await getVideoDuration(sourceVideo);
    const segmentDuration = 30; // 30 secondes par short
    const segmentCount = 5;
    
    console.log(`Splitting into ${segmentCount} segments...`);
    
    const segments = [];
    for (let i = 0; i < segmentCount; i++) {
      const startTime = (duration / segmentCount) * i;
      const segmentPath = path.join(outputDir, `short_${i + 1}.mp4`);
      const thumbnailPath = path.join(outputDir, `thumb_${i + 1}.jpg`);
      
      // Créer segment
      await createShort(sourceVideo, segmentPath, startTime, segmentDuration);
      
      // Générer thumbnail
      await generateThumbnail(segmentPath, thumbnailPath);
      
      // Upload vers storage
      const videoKey = `users/${job.userId}/${job.id}/short_${i + 1}.mp4`;
      const thumbKey = `users/${job.userId}/${job.id}/thumb_${i + 1}.jpg`;
      
      await uploadToStorage(segmentPath, videoKey, 'video/mp4');
      await uploadToStorage(thumbnailPath, thumbKey, 'image/jpeg');
      
      segments.push({
        index: i + 1,
        startTime,
        duration: segmentDuration,
        storageKey: videoKey,
        thumbnailKey: thumbKey,
        subtitle: `Short #${i + 1} | Meilleur moment`,
        size: (await fs.stat(segmentPath)).size
      });
      
      console.log(`Short ${i + 1}/${segmentCount} created`);
    }
    
    // Mettre à jour job avec résultats
    const updatedJobs = await readJobs();
    const updatedJobIndex = updatedJobs.findIndex(j => j.id === job.id);
    if (updatedJobIndex !== -1) {
      updatedJobs[updatedJobIndex].status = 'completed';
      updatedJobs[updatedJobIndex].completedAt = new Date().toISOString();
      updatedJobs[updatedJobIndex].segments = segments;
      await writeJobs(updatedJobs);
    }
    
    console.log(`Job ${job.id} completed successfully!`);
    
  } catch (error) {
    console.error(`Error processing job ${job.id}:`, error);
    
    // Marquer comme échec
    try {
      const jobs = await readJobs();
      const jobIndex = jobs.findIndex(j => j.id === job.id);
      if (jobIndex !== -1) {
        jobs[jobIndex].status = 'failed';
        jobs[jobIndex].error = error.message;
        await writeJobs(jobs);
      }
    } catch (dbError) {
      console.error('Failed to update job status:', dbError);
    }
  } finally {
    // Nettoyer
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError);
      }
    }
  }
}

// Fonctions FFmpeg
function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration);
    });
  });
}

function createShort(sourcePath, outputPath, startTime, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg(sourcePath)
      .setStartTime(startTime)
      .setDuration(duration)
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 26',
        '-c:a aac',
        '-b:a 96k',
        '-movflags +faststart',
        '-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,subtitles=fontsize=24:fontcolor=white:box=1:boxcolor=black@0.5:x=(w-text_w)/2:y=h-text_h-20"'
      ])
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

function generateThumbnail(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: [1],
        filename: path.basename(outputPath),
        folder: path.dirname(outputPath),
        size: '540x960'
      })
      .on('end', resolve)
      .on('error', reject);
  });
}

// ================= DÉMARRAGE =================
async function startServer() {
  await initDB();
  
  app.listen(PORT, () => {
    console.log(`🚀 Shorts Generator backend running on port ${PORT}`);
    console.log(`✅ Storage: Cloudflare R2`);
    console.log(`✅ DB: JSON files (simple)`);
    console.log(`✅ Credits: 100 offered on registration`);
  });
}

startServer().catch(console.error);
