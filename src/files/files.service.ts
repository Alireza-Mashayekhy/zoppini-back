import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class FilesService {
  saveFile(file: Express.Multer.File) {
    const uploadPath = path.join(__dirname, '../../uploads', file.originalname);
    fs.writeFileSync(uploadPath, file.buffer);
    return {
      mesage: 'File uploaded succesfully!',
      filename: file.originalname,
    };
  }

  deleteFile(filename: string) {
    const filePath = path.join(__dirname, '../../uploads', filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { message: 'File deleted successfully' };
    }
    return { message: 'File not found' };
  }
}
