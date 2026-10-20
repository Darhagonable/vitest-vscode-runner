import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { parse, stringify } from 'devalue';

export class FramedIpc extends EventEmitter {
  private buffer = Buffer.alloc(0);

  constructor(private readonly socket: Socket) {
    super();

    socket.on('data', chunk => this.read(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on('error', error => this.emit('error', error));
    socket.on('close', () => this.emit('close'));
  }

  send(message: unknown): void {
    const body = Buffer.from(stringify(message), 'utf8');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.byteLength, 0);
    this.socket.write(Buffer.concat([header, body]));
  }

  close(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32BE(0);

      if (this.buffer.byteLength < length + 4) {
        return;
      }

      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      this.emit('message', parse(body.toString('utf8')));
    }
  }
}
