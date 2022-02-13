import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import sharp from 'sharp';
import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { getInfo, videoInfo, getInfoOptions } from 'ytdl-core';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import fetch from 'node-fetch';
import HttpsProxyAgent from 'https-proxy-agent';
import { VideoDto } from 'viewtube/shared/dto/video/video.dto';
import { ChannelBasicInfo } from '../channels/schemas/channel-basic-info.schema';
import { Common } from '../common';
import { DashGenerator } from './dash.generator';
import { VideoBasicInfo } from './schemas/video-basic-info.schema';
import { VideoEntity } from './video.entity';
import { General } from 'common/general.schema';
import { ChannelBasicInfoDto } from 'core/channels/dto/channel-basic-info.dto';
import { VideoBasicInfoDto } from './dto/video-basic-info.dto';

@Injectable()
export class VideosService {
  constructor(
    @InjectModel(VideoBasicInfo.name)
    private readonly videoModel: Model<VideoBasicInfo>,
    @InjectModel(ChannelBasicInfo.name)
    private readonly channelModel: Model<ChannelBasicInfo>,
    private configService: ConfigService,
    @InjectModel(General.name)
    private readonly generalModel: Model<General>
  ) {}

  async getById(id: string): Promise<VideoDto> {
    const url: string = Common.youtubeVideoUrl + id;
    const generalConfig = await this.generalModel.findOne({ version: 1 }).exec();

    const useProxy = generalConfig?.proxyUntil?.valueOf() > Date.now();

    try {
      console.log('getting video without proxy');
      const video = this.fetchVideo(url, useProxy);
      return video;
    } catch (err) {
      console.log('error fetching video');

      if (!useProxy && this.configService.get('VIEWTUBE_PROXY_URL')) {
        console.log('trying again with proxy');
        try {
          const video = await this.fetchVideo(url, true);

          if (video && video.videoId) {
            console.log('successful, using proxy for next hour');

            const useProxyUntil = new Date();
            useProxyUntil.setHours(useProxyUntil.getHours() + 1);
            await this.generalModel
              .findOneAndUpdate({ id: 1 }, { proxyUntil: useProxyUntil }, { upsert: true })
              .exec();
          }

          return video;
        } catch (err) {
          throw new HttpException(
            {
              status: HttpStatus.INTERNAL_SERVER_ERROR,
              message: err.address && err.code ? err : err.message
            },
            HttpStatus.INTERNAL_SERVER_ERROR
          );
        }
      }

      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          message: err.address && err.code ? err : err.message
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  async fetchVideo(url: string, useExternalProxy?: boolean): Promise<VideoDto> {
    const ytdlOptions: getInfoOptions = {
      requestOptions: {
        ...this.getYoutubeCookieConfig(),
        ...(useExternalProxy ? this.getExternalProxyConfig() : {})
      }
    };

    const result: videoInfo = await getInfo(url, ytdlOptions);
    const video: VideoDto = new VideoEntity(result);

    return video;
  }

  getExternalProxyConfig() {
    const requestOptions: { [key: string]: any } = {};

    if (this.configService.get('VIEWTUBE_PROXY_URL')) {
      const proxy = this.configService.get('VIEWTUBE_PROXY_URL');
      const proxyAgent = HttpsProxyAgent(proxy);
      requestOptions.agent = proxyAgent;
    }
  }

  getYoutubeCookieConfig() {
    const requestOptions: { [key: string]: string } = {};

    if (this.configService.get('VIEWTUBE_YOUTUBE_COOKIE')) {
      requestOptions.cookie = this.configService.get('VIEWTUBE_YOUTUBE_COOKIE');
    }
    if (this.configService.get('VIEWTUBE_YOUTUBE_IDENTIFIER')) {
      requestOptions['x-youtube-identity-token'] = this.configService.get(
        'VIEWTUBE_YOUTUBE_IDENTIFIER'
      );
    }

    return requestOptions;
  }

  async storeVideoInformation(video: VideoDto) {
    const channelBasicInfo: ChannelBasicInfoDto = {
      authorId: video.authorId,
      author: video.author,
      authorThumbnails: video.authorThumbnails,
      authorVerified: video.authorVerified
    };
    const authorImageUrl = await this.saveAuthorImage(
      video.authorThumbnails[2].url,
      video.authorId
    );
    if (authorImageUrl) {
      channelBasicInfo.authorThumbnailUrl = authorImageUrl;
    }
    const videoBasicInfo: VideoBasicInfoDto = {
      author: video.author,
      authorId: video.authorId,
      description: video.description,
      dislikeCount: video.dislikeCount,
      likeCount: video.likeCount,
      published: video.published,
      publishedText: video.publishedText,
      title: video.title,
      videoId: video.videoId,
      videoThumbnails: video.videoThumbnails,
      viewCount: video.viewCount,
      lengthSeconds: video.lengthSeconds
    };
    this.channelModel
      .findOneAndUpdate({ authorId: video.authorId }, channelBasicInfo, { upsert: true })
      .exec()
      .catch();
    this.videoModel
      .findOneAndUpdate({ videoId: video.videoId }, videoBasicInfo, { upsert: true })
      .exec()
      .catch();

    // const dashManifest = DashGenerator.generateDashFileFromFormats(
    //   result.formats,
    //   result.videoDetails.lengthSeconds
    // );
  }

  async getDashManifest(id: string): Promise<string> {
    const url: string = Common.youtubeVideoUrl + id;
    const result: videoInfo = await getInfo(url);

    const dashManifest = DashGenerator.generateDashFileFromFormats(
      result.player_response.streamingData.adaptiveFormats,
      result.videoDetails.lengthSeconds
    );
    return dashManifest;
  }

  async saveAuthorImage(imgUrl: string, channelId: string) {
    const arrBuffer = await fetch(imgUrl, { method: 'GET' })
      .then(response => response.arrayBuffer())
      .catch(_ => {
        // Drop errors
      });

    if (arrBuffer) {
      try {
        const imgPath = path.join((global as any).__basedir, `channels/${channelId}.webp`);
        const appendFile = promisify(fs.appendFile);

        const imgBuffer = Buffer.from(arrBuffer);

        let success = true;

        const webpImage = await sharp(imgBuffer)
          .resize(36)
          .webp()
          .toBuffer()
          .catch(() => {
            success = false;
          });

        if (success && webpImage) {
          await appendFile(imgPath, webpImage);
          return `channels/${channelId}/thumbnail/tiny.webp`;
        }
        return null;
      } catch {
        return null;
      }
    }
  }
}
