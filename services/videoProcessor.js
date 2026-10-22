const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

ffmpeg.setFfmpegPath(ffmpegPath);

// Always write temporary files to the writable /tmp directory
const TMP_DIR = os.tmpdir();

async function downloadVideo(url, outputPath, onProgress) {
  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }
  });

  const totalLength = parseInt(response.headers['content-length'], 10) || 0;
  let downloaded = 0;

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);

    response.data.on('data', (chunk) => {
      downloaded += chunk.length;
      if (totalLength && onProgress) {
        onProgress(Math.round((downloaded / totalLength) * 100));
      }
    });

    response.data.pipe(writer);
    writer.on('finish', () => resolve(outputPath));
    writer.on('error', reject);
  });
}

function makeSquare800(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-vf scale=800:800:force_original_aspect_ratio=decrease,pad=800:800:(800-iw)/2:(800-ih)/2:black",
        "-c:v libx264",
        "-preset ultrafast", // Essential on serverless to finish within timeout
        "-pix_fmt yuv420p",
        "-r 30",
        "-c:a aac",
        "-b:a 128k",
        "-movflags +faststart"
      ])
      .toFormat('mp4')
      .save(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err));
  });
}

function generateThumbnail(videoPath, thumbnailPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ['00:00:01.000'],
        filename: path.basename(thumbnailPath),
        folder: path.dirname(thumbnailPath),
        size: '400x400'
      })
      .on('end', () => resolve(thumbnailPath))
      .on('error', (err) => reject(err));
  });
}

module.exports = {
  TMP_DIR,
  downloadVideo,
  makeSquare800,
  generateThumbnail
};