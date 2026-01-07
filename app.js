// ============================================
// BACKEND COMPLET - Shorts Generator Pro
// Avec FFmpeg + Sous-titres automatiques
// ============================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('youtube-dl-exec');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Initialisation
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Connexion MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost/shorts-pro', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// ================= MODÈLES =================
const UserSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  credits: { type: Number, default: 100 },
  createdAt: { type: Date, default: Date.now }
});

UserSchema.pre('save', async function(next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});

const JobSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  youtubeUrl: { type: String, required: true },
  videoTitle: String,
  videoDuration: Number,
  
  // Configuration du short
  segmentDuration: { type: Number, enum: [15, 30, 60], default: 30 },
  segmentCount: { type: Number, min: 1, max: 20, default: 3 },
  
  // Sous-titres
  subtitlesEnabled: { type: Boolean, default: true },
  subtitleStyle: {
    fontSize: { type: Number, default: 24 },
    color: { type: String, default: 'white' },
    backgroundColor: { type: String, default: 'black@0.5' }
  },
  
  // État
  status: { 
    type: String, 
    enum: ['pending', 'downloading', 'processing', 'completed', 'failed'], 
    default: 'pending' 
  },
  creditsUsed: Number,
  
  // Résultats
  segments: [{
    index: Number,
    startTime: Number,
    duration: Number,
    storageKey: String,
    subtitleText: String,
    thumbnailUrl: String,
    createdAt: { type: Date, default: Date.now }
  }],
  
  // Expiration
  expiresAt: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
  
  createdAt: { type: Date, default: Date.now },
  completedAt: Date
});

const User = mongoose.model('User', UserSchema);
const Job = mongoose.model('Job', JobSchema);

// ================= CONFIGURATION =================
const PRICES = { 15: 2, 30: 5, 60: 8 };

// Configuration Cloudflare R2 / S3
const s3Client = new S3Client({
  region: process.env.STORAGE_REGION || 'auto',
  endpoint: process.env.STORAGE_ENDPOINT,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY,
    secretAccessKey: process.env.STORAGE_SECRET_KEY,
  },
  forcePathStyle: true,
});

// ================= MIDDLEWARE =================
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) throw new Error('No token');
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    req.user = await User.findById(decoded.userId);
    if (!req.user) throw new Error('User not found');
    
    next();
  } catch (error) {
    res.status(401).json({ success: false, error: 'Authentication required' });
  }
};

// ================= ROUTES API =================

// 1. INSCRIPTION
app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Vérifier si utilisateur existe
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email already registered' 
      });
    }
    
    // Créer utilisateur
    const user = new User({ email, password, credits: 100 });
    await user.save();
    
    // Générer token
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'secret', {
      expiresIn: '7d'
    });
    
    res.json({
      success: true,
      token,
      user: { id: user._id, email: user.email, credits: user.credits }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. CONNEXION
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const user = await User.findOne({ email });
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
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'secret', {
      expiresIn: '7d'
    });
    
    res.json({
      success: true,
      token,
      user: { id: user._id, email: user.email, credits: user.credits }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. PRÉVISUALISATION
app.post('/api/preview', authMiddleware, async (req, res) => {
  try {
    const { youtubeUrl, segmentDuration = 30, segmentCount = 3, subtitlesEnabled = true } = req.body;
    
    // Valider l'URL YouTube
    if (!youtubeUrl.includes('youtube.com') && !youtubeUrl.includes('youtu.be')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid YouTube URL' 
      });
    }
    
    // Obtenir les infos de la vidéo
    const videoInfo = await exec(youtubeUrl, {
      dumpJson: true,
      noWarnings: true
    }).catch(() => ({ title: 'Unknown', duration: 300 }));
    
    // Calculer le coût
    const costPerSegment = PRICES[segmentDuration] || 5;
    const totalCost = costPerSegment * segmentCount;
    
    // Vérifier si l'utilisateur a assez de crédits
    const canAfford = req.user.credits >= totalCost;
    
    res.json({
      success: true,
      data: {
        videoTitle: videoInfo.title || 'YouTube Video',
        videoDuration: videoInfo.duration || 300,
        segmentDuration,
        segmentCount,
        subtitlesEnabled,
        costPerSegment,
        totalCost,
        userCredits: req.user.credits,
        canAfford,
        estimatedTime: Math.ceil((videoInfo.duration || 300) * 0.2) // 20% de la durée
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. CRÉATION DE JOB
app.post('/api/jobs', authMiddleware, async (req, res) => {
  try {
    const { youtubeUrl, segmentDuration = 30, segmentCount = 3, subtitlesEnabled = true } = req.body;
    
    // Calculer le coût
    const costPerSegment = PRICES[segmentDuration] || 5;
    const totalCost = costPerSegment * segmentCount;
    
    // Vérifier les crédits
    if (req.user.credits < totalCost) {
      return res.status(402).json({ 
        success: false, 
        error: `Insufficient credits. Need ${totalCost}, have ${req.user.credits}` 
      });
    }
    
    // Déduire les crédits
    req.user.credits -= totalCost;
    await req.user.save();
    
    // Créer le job
    const job = new Job({
      userId: req.user._id,
      youtubeUrl,
      segmentDuration,
      segmentCount,
      subtitlesEnabled,
      creditsUsed: totalCost,
      status: 'pending'
    });
    
    await job.save();
    
    // Démarrer le traitement en arrière-plan
    processJobInBackground(job._id);
    
    res.json({
      success: true,
      data: {
        jobId: job._id,
        status: job.status,
        creditsUsed: totalCost,
        remainingCredits: req.user.credits,
        message: 'Processing started in background'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. SUIVI DE JOB
app.get('/api/jobs/:id', authMiddleware, async (req, res) => {
  try {
    const job = await Job.findOne({ 
      _id: req.params.id, 
      userId: req.user._id 
    });
    
    if (!job) {
      return res.status(404).json({ 
        success: false, 
        error: 'Job not found' 
      });
    }
    
    // Générer les URLs pour les segments complétés
    let segmentsWithUrls = [];
    if (job.status === 'completed' && job.segments.length > 0) {
      segmentsWithUrls = await Promise.all(
        job.segments.map(async (segment) => {
          if (segment.storageKey) {
            const previewUrl = await generateSignedUrl(segment.storageKey, 7 * 24 * 60 * 60);
            const downloadUrl = await generateSignedUrl(segment.storageKey, 24 * 60 * 60);
            
            return {
              ...segment.toObject(),
              previewUrl, // Visionnage 7 jours
              downloadUrl, // Téléchargement 24h
              shareUrls: {
                tiktok: `tiktok://upload?video_url=${encodeURIComponent(downloadUrl)}`,
                instagram: `instagram://library?AssetPath=${encodeURIComponent(downloadUrl)}`
              }
            };
          }
          return segment;
        })
      );
    }
    
    res.json({
      success: true,
      data: {
        job: {
          ...job.toObject(),
          segments: segmentsWithUrls
        },
        expiresIn: Math.ceil((job.expiresAt - new Date()) / (1000 * 60 * 60 * 24))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. LISTE DES JOBS
app.get('/api/jobs', authMiddleware, async (req, res) => {
  try {
    const jobs = await Job.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(20);
    
    res.json({
      success: true,
      data: { jobs }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. PROFIL UTILISATEUR
app.get('/api/profile', authMiddleware, async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        user: {
          email: req.user.email,
          credits: req.user.credits,
          createdAt: req.user.createdAt
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================= FONCTIONS DE TRAITEMENT =================

async function processJobInBackground(jobId) {
  try {
    const job = await Job.findById(jobId);
    if (!job) return;
    
    job.status = 'downloading';
    await job.save();
    
    // Créer un dossier temporaire
    const tempDir = `./temp/${jobId}_${Date.now()}`;
    await fs.mkdir(tempDir, { recursive: true });
    
    const sourceVideo = path.join(tempDir, 'source.mp4');
    const audioFile = path.join(tempDir, 'audio.mp3');
    
    // 1. Télécharger la vidéo YouTube
    console.log(`Downloading YouTube video for job ${jobId}...`);
    await exec(job.youtubeUrl, {
      output: sourceVideo,
      format: 'best[ext=mp4]/best',
      noWarnings: true
    });
    
    job.status = 'processing';
    await job.save();
    
    // 2. Extraire l'audio pour les sous-titres
    if (job.subtitlesEnabled) {
      console.log('Extracting audio for subtitles...');
      await extractAudio(sourceVideo, audioFile);
      
      // Ici, vous pourriez utiliser un service de transcription
      // Pour le MVP, on utilise des sous-titres simulés
      const mockSubtitles = generateMockSubtitles(job.segmentDuration, job.segmentCount);
      job.segments = mockSubtitles;
    }
    
    // 3. Traiter chaque segment avec FFmpeg
    console.log(`Processing ${job.segmentCount} segments...`);
    
    for (let i = 0; i < job.segmentCount; i++) {
      const segment = await processSegment({
        jobId,
        index: i + 1,
        sourceVideo,
        segmentDuration: job.segmentDuration,
        totalSegments: job.segmentCount,
        videoDuration: await getVideoDuration(sourceVideo),
        subtitlesEnabled: job.subtitlesEnabled,
        subtitleText: job.subtitlesEnabled ? `Segment ${i + 1} - Generated by Shorts Pro` : null,
        tempDir
      });
      
      job.segments[i] = job.segments[i] || {};
      Object.assign(job.segments[i], segment);
      
      console.log(`Segment ${i + 1}/${job.segmentCount} processed`);
    }
    
    // 4. Marquer comme terminé
    job.status = 'completed';
    job.completedAt = new Date();
    await job.save();
    
    console.log(`Job ${jobId} completed successfully!`);
    
    // 5. Nettoyer les fichiers temporaires
    await fs.rm(tempDir, { recursive: true, force: true });
    
  } catch (error) {
    console.error(`Error processing job ${jobId}:`, error);
    
    const job = await Job.findById(jobId);
    if (job) {
      job.status = 'failed';
      await job.save();
      
      // Rembourser les crédits en cas d'échec
      const user = await User.findById(job.userId);
      if (user) {
        user.credits += job.creditsUsed;
        await user.save();
      }
    }
  }
}

async function processSegment(options) {
  const {
    jobId,
    index,
    sourceVideo,
    segmentDuration,
    totalSegments,
    videoDuration,
    subtitlesEnabled,
    subtitleText,
    tempDir
  } = options;
  
  // Calculer le temps de départ
  const segmentSpacing = videoDuration / totalSegments;
  const startTime = (index - 1) * segmentSpacing;
  
  const outputFile = path.join(tempDir, `segment_${index}.mp4`);
  const thumbnailFile = path.join(tempDir, `thumb_${index}.jpg`);
  
  // Commande FFmpeg pour créer le short
  const ffmpegCommand = ffmpeg(sourceVideo)
    .setStartTime(startTime)
    .setDuration(segmentDuration)
    .outputOptions([
      '-c:v libx264',
      '-preset fast',
      '-crf 23',
      '-c:a aac',
      '-b:a 128k',
      '-movflags +faststart'
    ]);
  
  // 1. Conversion en format vertical (9:16)
  ffmpegCommand.videoFilter('scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2');
  
  // 2. Ajouter des sous-titres si activé
  if (subtitlesEnabled && subtitleText) {
    ffmpegCommand.videoFilter(
      `drawtext=text='${subtitleText}':` +
      `fontsize=24:fontcolor=white:` +
      `box=1:boxcolor=black@0.5:` +
      `boxborderw=5:` +
      `x=(w-text_w)/2:y=h-(text_h*2)`
    );
  }
  
  // 3. Appliquer des filtres pour améliorer le short
  ffmpegCommand.videoFilter('eq=brightness=0.05:saturation=1.1');
  
  // Exécuter la conversion
  await new Promise((resolve, reject) => {
    ffmpegCommand
      .on('end', resolve)
      .on('error', reject)
      .save(outputFile);
  });
  
  // 4. Générer une miniature
  await new Promise((resolve, reject) => {
    ffmpeg(outputFile)
      .screenshots({
        timestamps: [1],
        filename: `thumb_${index}.jpg`,
        folder: tempDir,
        size: '540x960'
      })
      .on('end', resolve)
      .on('error', reject);
  });
  
  // 5. Upload vers le stockage
  const segmentKey = `shorts/${jobId}/segment_${index}.mp4`;
  const thumbKey = `shorts/${jobId}/thumb_${index}.jpg`;
  
  await uploadToStorage(outputFile, segmentKey, 'video/mp4');
  await uploadToStorage(thumbnailFile, thumbKey, 'image/jpeg');
  
  return {
    index,
    startTime,
    duration: segmentDuration,
    storageKey: segmentKey,
    thumbnailUrl: thumbKey,
    subtitleText: subtitlesEnabled ? subtitleText : null,
    createdAt: new Date()
  };
}

// ================= UTILITAIRES =================

async function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .output(audioPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration);
    });
  });
}

function generateMockSubtitles(segmentDuration, segmentCount) {
  const subtitles = [];
  for (let i = 0; i < segmentCount; i++) {
    subtitles.push({
      index: i + 1,
      subtitleText: `Short #${i + 1} | ${segmentDuration}s | Generated automatically`
    });
  }
  return subtitles;
}

async function uploadToStorage(filePath, key, contentType) {
  const fileBuffer = await fs.readFile(filePath);
  
  const command = new PutObjectCommand({
    Bucket: process.env.STORAGE_BUCKET || 'shorts-videos',
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
    ACL: 'private'
  });
  
  await s3Client.send(command);
  return key;
}

async function generateSignedUrl(key, expiresIn = 3600) {
  const command = new GetObjectCommand({
    Bucket: process.env.STORAGE_BUCKET || 'shorts-videos',
    Key: key
  });
  
  return await getSignedUrl(s3Client, command, { expiresIn });
}

// ================= TÂCHES AUTOMATIQUES =================

// Nettoyage des vieux jobs (7 jours)
setInterval(async () => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oldJobs = await Job.find({ 
      createdAt: { $lt: sevenDaysAgo },
      status: 'completed'
    });
    
    for (const job of oldJobs) {
      // Supprimer les fichiers de stockage
      for (const segment of job.segments) {
        if (segment.storageKey) {
          try {
            const deleteCommand = new DeleteObjectCommand({
              Bucket: process.env.STORAGE_BUCKET,
              Key: segment.storageKey
            });
            await s3Client.send(deleteCommand);
          } catch (err) {
            console.error('Error deleting file:', err.message);
          }
        }
      }
      
      // Supprimer le job de la base
      await job.deleteOne();
      console.log(`Cleaned up expired job ${job._id}`);
    }
  } catch (error) {
    console.error('Error in cleanup task:', error);
  }
}, 24 * 60 * 60 * 1000); // Tous les jours

// ================= DÉMARRAGE =================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Shorts Generator Pro backend running on port ${PORT}`);
  console.log(`💰 Prices: 15s=${PRICES[15]} credits | 30s=${PRICES[30]} credits | 60s=${PRICES[60]} credits`);
});
