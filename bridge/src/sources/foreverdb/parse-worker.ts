import { decodeForeverDataset } from './decode.js';
process.once('message', (input) => {
  const {files,metadata} = input as {files:[string,Uint8Array][];metadata:{datasetId:string;archiveSha256:string}};
  let reply;
  try { reply = {ok:true,dataset:decodeForeverDataset({...metadata,files:new Map(files)})}; }
  catch(error) { reply={ok:false,code:error && typeof error==='object' && 'code' in error ? String(error.code) : 'decode_failed',message:String(error)}; }
  process.send!(reply,()=>process.disconnect());
});
