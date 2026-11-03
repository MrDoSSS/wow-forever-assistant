// A SAPI 5 voice used only as an explicit, silent transport for ForeverAssistant.
// It never becomes the Windows default voice and never synthesizes speech.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

[assembly: System.Reflection.AssemblyVersion("3.0.0.0")]
[assembly: ComVisible(false)]

namespace ForeverAssistant.Voice
{
    [ComVisible(true), Guid("A74D7C8E-4CC5-4F2F-A6EB-804DEE18500E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISpTTSEngine
    {
        [PreserveSig] int Speak(uint flags, ref Guid format, IntPtr waveFormat, IntPtr fragments, IntPtr site);
        [PreserveSig] int GetOutputFormat(IntPtr targetFormat, IntPtr targetWave, out Guid format, out IntPtr wave);
    }

    [ComVisible(true), Guid("5B559F40-E952-11D2-BB91-00C04F8EE6C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISpObjectWithToken
    {
        [PreserveSig] int SetObjectToken(IntPtr token);
        [PreserveSig] int GetObjectToken(out IntPtr token);
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SpeechEvent
    {
        public ushort EventId, ParameterType;
        public uint StreamNumber;
        public ulong AudioOffset;
        public UIntPtr WParam;
        public IntPtr LParam;
    }

    [ComImport, Guid("9880499B-CCE9-11D2-B503-00C04F797396"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ISpTTSEngineSite
    {
        [PreserveSig] int AddEvents(ref SpeechEvent events, uint count);
        [PreserveSig] int GetEventInterest(out ulong interest);
        [PreserveSig] uint GetActions();
        [PreserveSig] int Write(IntPtr bytes, uint count, out uint written);
        [PreserveSig] int GetRate(out int rate);
        [PreserveSig] int GetVolume(out ushort volume);
        [PreserveSig] int GetSkipInfo(out int type, out int count);
        [PreserveSig] int CompleteSkip(int count);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct VoiceState
    {
        public int Action;
        public ushort Language, Reserved;
        public int Emphasis, Rate;
        public uint Volume;
        public int PitchMiddle, PitchRange;
        public uint SilenceMilliseconds;
        public IntPtr PhoneIds;
        public int PartOfSpeech;
        public IntPtr Category, Before, After;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct TextFragment
    {
        public IntPtr Next;
        public VoiceState State;
        public IntPtr Text;
        public uint Length, Offset;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    internal struct WaveFormat
    {
        public ushort Tag, Channels;
        public uint SamplesPerSecond, BytesPerSecond;
        public ushort BlockAlign, BitsPerSample, ExtraSize;
    }

    [ComVisible(true), Guid("FD0302DD-34DE-44AD-8DCE-02A6C4A03303"), ClassInterface(ClassInterfaceType.None), ComDefaultInterface(typeof(ISpTTSEngine))]
    public sealed class SilentVoice : ISpTTSEngine, ISpObjectWithToken
    {
        private IntPtr token;
        private static string lastConfigFingerprint;
        private static readonly Guid WaveFormatId = new Guid("C31ADBAE-527F-4FF5-A230-F62BB61FF70C");

        public SilentVoice() { Log("created v3"); }
        ~SilentVoice() { if (token != IntPtr.Zero) Marshal.Release(token); }

        public int SetObjectToken(IntPtr value)
        {
            if (value == IntPtr.Zero) return unchecked((int)0x80004003);
            if (token != IntPtr.Zero) return unchecked((int)0x80045001);
            Marshal.AddRef(value);
            token = value;
            return 0;
        }

        public int GetObjectToken(out IntPtr value)
        {
            value = token;
            if (value == IntPtr.Zero) return unchecked((int)0x80045002);
            Marshal.AddRef(value);
            return 0;
        }

        public int GetOutputFormat(IntPtr targetFormat, IntPtr targetWave, out Guid format, out IntPtr wave)
        {
            format = WaveFormatId;
            WaveFormat pcm = new WaveFormat { Tag = 1, Channels = 1, SamplesPerSecond = 22050, BytesPerSecond = 44100, BlockAlign = 2, BitsPerSample = 16 };
            wave = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WaveFormat)));
            Marshal.StructureToPtr(pcm, wave, false);
            return 0;
        }

        public int Speak(uint flags, ref Guid format, IntPtr waveFormat, IntPtr fragments, IntPtr sitePointer)
        {
            try
            {
                ISpTTSEngineSite site = (ISpTTSEngineSite)Marshal.GetObjectForIUnknown(sitePointer);
                StringBuilder text = new StringBuilder();
                int visited = 0;
                for (IntPtr cursor = fragments; cursor != IntPtr.Zero; )
                {
                    if (++visited > 4096) throw new InvalidDataException("Too many fragments");
                    TextFragment fragment = (TextFragment)Marshal.PtrToStructure(cursor, typeof(TextFragment));
                    if (fragment.Length > 262144 || text.Length + fragment.Length > 262144) throw new InvalidDataException("Text too long");
                    if (fragment.Text != IntPtr.Zero && fragment.Length > 0)
                    {
                        string part = Marshal.PtrToStringUni(fragment.Text, checked((int)fragment.Length));
                        if (fragment.State.Action == 3) SendBookmark(site, part);
                        else if (fragment.State.Action == 0 || fragment.State.Action == 4) text.Append(part);
                    }
                    cursor = fragment.Next;
                }
                string input = text.ToString();
                if (input.StartsWith("FAV1:PING:", StringComparison.Ordinal))
                {
                    string nonce = input.Substring(10);
                    if (nonce.Length <= 128)
                    {
                        Log("ping " + nonce);
                        SendBookmark(site, "FAV1:PONG:" + nonce);
                    }
                }
                else if (input.StartsWith("FAV2:", StringComparison.Ordinal) && input.Length <= 8192)
                {
                    foreach (string bookmark in Exchange(input)) SendBookmark(site, bookmark);
                }
                // Advance the output stream so queued bookmark events are delivered.
                // Every sample is zero: this voice can only produce silence.
                uint written;
                byte[] silence = new byte[2206];
                GCHandle pinned = GCHandle.Alloc(silence, GCHandleType.Pinned);
                try { return site.Write(pinned.AddrOfPinnedObject(), (uint)silence.Length, out written); }
                finally { pinned.Free(); }
            }
            catch (Exception error)
            {
                Log("error " + error.GetType().Name + " " + error.Message);
                return Marshal.GetHRForException(error);
            }
        }

        private static string[] Exchange(string input)
        {
            string stage = "config";
            try
            {
                // The host and a packaged launcher can have different AppData views.
                // A file next to this assembly has the same absolute path in both.
                string path = Path.Combine(Path.GetDirectoryName(typeof(SilentVoice).Assembly.Location), "voice-transport.txt");
                if (!File.Exists(path)) path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ForeverAssistant", "voice-transport.txt");
                string[] config = File.ReadAllLines(path);
                if (config.Length == 2) {
                    using (SHA256 sha = SHA256.Create()) {
                        string fingerprint = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(config[1]))).Replace("-", "").Substring(0, 12);
                        if (lastConfigFingerprint != fingerprint) { lastConfigFingerprint = fingerprint; Log("config " + path + " fingerprint=" + fingerprint); }
                    }
                }
                Uri endpoint;
                if (config.Length != 2 || !Uri.TryCreate(config[0], UriKind.Absolute, out endpoint)
                    || endpoint.Scheme != "http" || endpoint.Host != "127.0.0.1" || endpoint.Port < 1024
                    || endpoint.AbsolutePath != "/voice" || endpoint.Query.Length != 0
                    || config[1].Length != 64) return new[] { "FAV2:ERROR:config_invalid:0" };
                stage = "http";
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(endpoint);
                request.Method = "POST";
                request.Proxy = null;
                request.AllowAutoRedirect = false;
                request.Timeout = 1500;
                request.ReadWriteTimeout = 1500;
                request.ContentType = "text/plain; charset=utf-8";
                request.Headers["X-Forever-Voice-Token"] = config[1];
                byte[] data = Encoding.UTF8.GetBytes(input);
                request.ContentLength = data.Length;
                using (Stream output = request.GetRequestStream()) output.Write(data, 0, data.Length);
                using (WebResponse response = request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    char[] buffer = new char[32768];
                    int count = 0, read;
                    while ((read = reader.Read(buffer, count, buffer.Length - count)) > 0)
                    {
                        count += read;
                        if (count == buffer.Length) throw new InvalidDataException("Response too large");
                    }
                    string[] bookmarks = new string(buffer, 0, count).Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
                    if (bookmarks.Length > 16) throw new InvalidDataException("Too many bookmarks");
                    foreach (string bookmark in bookmarks)
                        if (!bookmark.StartsWith("FAV2:", StringComparison.Ordinal) || bookmark.Length > 2048)
                            throw new InvalidDataException("Invalid bookmark");
                    return bookmarks;
                }
            }
            catch (Exception error)
            {
                string code = stage + ":" + Marshal.GetHRForException(error).ToString("X8");
                Log("exchange " + code + " " + error.GetType().Name);
                return new[] { "FAV2:ERROR:" + code };
            }
        }

        private static void SendBookmark(ISpTTSEngineSite site, string value)
        {
            IntPtr name = Marshal.StringToCoTaskMemUni(value);
            try
            {
                SpeechEvent item = new SpeechEvent { EventId = 4, ParameterType = 4, LParam = name };
                int result = site.AddEvents(ref item, 1);
                if (result < 0) Marshal.ThrowExceptionForHR(result);
            }
            finally { Marshal.FreeCoTaskMem(name); }
        }

        private static void Log(string message)
        {
            try
            {
                string directory = Path.GetDirectoryName(typeof(SilentVoice).Assembly.Location);
                Directory.CreateDirectory(directory);
                File.AppendAllText(Path.Combine(directory, "voice-runtime.log"), DateTime.UtcNow.ToString("o") + " pid=" + Process.GetCurrentProcess().Id + " " + message + Environment.NewLine, new UTF8Encoding(false));
            }
            catch { }
        }
    }
}
