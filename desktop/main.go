// Neon City Agents as a desktop app (macOS for now). The agent server (server/index.mjs, compiled by Bun into
// resources/<os>-<arch>/neon-city-server by scripts/build.mjs) runs as a helper on 127.0.0.1:5210, where the
// harnesses' hooks already post, and serves the game the app ships (Resources/dist). The window shows that page,
// so the game reaches the server on its own origin, as it does from `npm run dev`.
//
// Closing the window keeps the app, and so the server, running, as macOS apps do: agents keep reporting, and a
// click on the Dock icon brings the city back.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/egoist/mygo"
)

const defaultPort = 5210

// the helper process and how it was started
type server struct {
	mu   sync.Mutex
	cmd  *exec.Cmd
	done chan struct{} // closed when the process has exited
	port int
	busy bool // defaultPort was taken by something else, so port is another
}

// settings the app keeps between launches
type settings struct {
	Demo bool `json:"demo"` // run the mock agents
}

var (
	srv  = &server{}
	conf = settings{Demo: true}
	win  *mygo.Window
)

func main() {
	if !mygo.App.RequestSingleInstanceLock() {
		return // the running instance comes to the front
	}
	loadSettings()
	mygo.App.SetMenu(menu())
	mygo.App.OnSecondInstance(func(args []string, workingDir string) { showWindow() })
	mygo.App.WhenReady(func() {
		go func() {
			if err := srv.start(conf.Demo); err != nil {
				mygo.Dialog.Error("Neon City Agents could not start its agent server", err.Error())
				mygo.App.Quit()
				return
			}
			showWindow()
		}()
	})
	// the city stays up with its window closed; the Dock icon opens it again
	mygo.App.OnWindowAllClosed(func() {})
	mygo.App.OnActivate(func(hasVisibleWindows bool) {
		if !hasVisibleWindows {
			showWindow()
		}
	})
	mygo.App.OnQuit(srv.stop)
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

func showWindow() {
	if win != nil && !win.IsDestroyed() {
		win.Restore()
		win.Focus()
		return
	}
	if srv.url() == "" {
		return // still starting: the window opens once the server answers
	}
	// a modal dialog here would hold the page's frames (and its boot) until dismissed: the title says it instead
	title := "Neon City Agents"
	if srv.busy {
		title = fmt.Sprintf("Neon City Agents · port %d in use, agent server on %d", defaultPort, srv.port)
		log.Printf("port %d is in use (npm run dev?): the agent server runs on %d; hooks that post to %d reach the other server", defaultPort, srv.port, defaultPort)
	}
	win = mygo.NewWindow(mygo.WindowOptions{
		Title:           title,
		Width:           1440,
		Height:          900,
		MinWidth:        960,
		MinHeight:       600,
		BackgroundColor: "#03040a",
		StateKey:        "main",
		URL:             srv.url() + os.Getenv("NCA_QUERY"), // NCA_QUERY: e.g. ?webgl, to try the game's switches
		// the engine and the radio start on the first key or click anyway; this keeps a reload from muting them
		Page: mygo.PageOptions{Autoplay: mygo.AutoplayAllow, PreloadScript: catchErrors},
	})
	// the page's <title> would replace the note
	win.Page().OnPageTitleUpdated(func(e *mygo.TitleEvent) { e.PreventDefault() })
	if os.Getenv("NCA_DIAG") != "" {
		go diagnose(win)
	}
}

// what the page throws, kept on window.__ncaErrors for diagnose
const catchErrors = `(() => {
  const errs = (window.__ncaErrors = []);
  const keep = (s) => { if (errs.length < 50) errs.push(String(s).slice(0, 500)); };
  addEventListener('error', (e) => keep('error: ' + (e.message || e.error)));
  addEventListener('unhandledrejection', (e) => keep('rejection: ' + (e.reason?.stack || e.reason)));
  // frames and timer ticks, so diagnose can tell a page the web view stopped drawing from one that is working
  window.__ncaFrames = 0; window.__ncaTicks = 0;
  const frame = () => { window.__ncaFrames++; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  setInterval(() => window.__ncaTicks++, 1000);
  const ce = console.error.bind(console);
  console.error = (...a) => { keep('console: ' + a.map((x) => x?.stack || x).join(' ')); ce(...a); };
})();`

// NCA_DIAG=1: every few seconds, how far the page got, into page.log beside the server's
func diagnose(w *mygo.Window) {
	dir, err := mygo.App.Path(mygo.PathLogs)
	if err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(dir, "page.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	const probe = `JSON.stringify({ loader: document.querySelector('#loader .st')?.textContent, bar: document.querySelector('#loader .bar i')?.style.width,
		err: document.querySelector('#loader .err')?.textContent, boot: window.__nzBoot, ready: !!window.__nz?.ready, gpu: !!navigator.gpu,
		visible: document.visibilityState, focus: document.hasFocus(), frames: window.__ncaFrames, ticks: window.__ncaTicks, errors: window.__ncaErrors })`
	for i := 0; i < 60 && !w.IsDestroyed(); i++ {
		time.Sleep(3 * time.Second)
		v, err := w.Page().Eval(probe)
		fmt.Fprintf(f, "%s %v %v\n", time.Now().Format("15:04:05"), v, err)
	}
}

func menu() *mygo.Menu {
	return mygo.NewMenu([]*mygo.MenuItem{
		{Role: mygo.RoleAppMenu},
		{Role: mygo.RoleEditMenu},
		{Label: "View", Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleReload},
			mygo.Separator(),
			{Role: mygo.RoleToggleFullScreen},
			{Role: mygo.RoleToggleDevTools},
		}},
		{Label: "Agents", Submenu: []*mygo.MenuItem{
			{Label: "Demo Agents", Type: mygo.MenuItemCheckbox, Checked: conf.Demo, Click: func(item *mygo.MenuItem, _ *mygo.Window) {
				conf.Demo = item.Checked
				saveSettings()
				// the page's feed reconnects by itself and takes the new server's snapshot
				go func() {
					if err := srv.restart(conf.Demo); err != nil {
						mygo.Dialog.Error("The agent server did not restart", err.Error())
					}
				}()
			}},
			mygo.Separator(),
			{Label: "Copy Agent Server URL", Click: func(*mygo.MenuItem, *mygo.Window) {
				mygo.Clipboard.WriteText(fmt.Sprintf("http://127.0.0.1:%d", srv.port))
			}},
			{Label: "Show Server Log", Click: func(*mygo.MenuItem, *mygo.Window) {
				if dir, err := mygo.App.Path(mygo.PathLogs); err == nil {
					_ = mygo.Shell.OpenPath(filepath.Join(dir, "server.log"))
				}
			}},
		}},
		{Role: mygo.RoleWindowMenu},
	})
}

// ---- the helper ----

func (s *server) url() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil {
		return ""
	}
	return fmt.Sprintf("http://127.0.0.1:%d/", s.port)
}

// start runs the helper and waits until it answers
func (s *server) start(demo bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.port == 0 {
		s.port, s.busy = choosePort()
	}
	cmd, dist, err := helper()
	if err != nil {
		return err
	}
	if demo {
		cmd.Args = append(cmd.Args, "--mock")
	}
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("PORT=%d", s.port), "HOST=127.0.0.1",
		"AGENT_CITY_DIST="+dist, fmt.Sprintf("AGENT_CITY_PARENT_PID=%d", os.Getpid()))
	if dir, err := mygo.App.Path(mygo.PathLogs); err == nil {
		if f, err := os.OpenFile(filepath.Join(dir, "server.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
			cmd.Stdout, cmd.Stderr = f, f
		}
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not run %s: %w", cmd.Path, err)
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	s.cmd, s.done = cmd, done
	health := fmt.Sprintf("http://127.0.0.1:%d/api/health", s.port)
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); {
		select {
		case <-done:
			s.cmd = nil
			return errors.New("the agent server stopped as it started; see Agents > Show Server Log")
		case <-time.After(150 * time.Millisecond):
		}
		if r, err := http.Get(health); err == nil {
			r.Body.Close()
			if r.StatusCode == http.StatusOK {
				return nil
			}
		}
	}
	return errors.New("the agent server did not answer within 15 seconds; see Agents > Show Server Log")
}

func (s *server) stop() {
	s.mu.Lock()
	cmd, done := s.cmd, s.done
	s.cmd = nil
	s.mu.Unlock()
	if cmd == nil {
		return
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		_ = cmd.Process.Kill()
		<-done
	}
}

func (s *server) restart(demo bool) error {
	s.stop()
	return s.start(demo)
}

// defaultPort when it is free, else any free port
func choosePort() (int, bool) {
	if l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", defaultPort)); err == nil {
		l.Close()
		return defaultPort, false
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return defaultPort, false
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, true
}

// The helper and the game it serves. A built app has both in its resources; under `mygo dev` (resources is the
// project's) the compiled helper may not exist yet, and then the server runs from source with Node, serving the
// game built at the repo's root.
func helper() (*exec.Cmd, string, error) {
	res, err := mygo.App.Path(mygo.PathResources)
	if err != nil {
		return nil, "", err
	}
	dist := filepath.Join(res, "dist")
	if !exists(dist) {
		dist = filepath.Join(res, "..", "..", "dist")
	}
	for _, bin := range []string{
		filepath.Join(res, "neon-city-server"),
		filepath.Join(res, runtime.GOOS+"-"+runtime.GOARCH, "neon-city-server"),
	} {
		if exists(bin) {
			return exec.Command(bin), dist, nil
		}
	}
	src := filepath.Join(res, "..", "..", "server", "index.mjs")
	if node, err := exec.LookPath("node"); err == nil && exists(src) {
		return exec.Command(node, src), dist, nil
	}
	return nil, "", fmt.Errorf("the agent server is missing from %s (build the app with `npm run app:build`)", res)
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// ---- settings ----

func settingsPath() string {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "settings.json")
}

func loadSettings() {
	if b, err := os.ReadFile(settingsPath()); err == nil {
		_ = json.Unmarshal(b, &conf)
	}
}

func saveSettings() {
	if b, err := json.MarshalIndent(conf, "", "  "); err == nil {
		_ = os.WriteFile(settingsPath(), b, 0o644)
	}
}
