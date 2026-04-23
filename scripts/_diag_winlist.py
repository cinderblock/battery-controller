import sys
from pywinauto import Application
app = Application(backend="win32").connect(process=35808)
wins = app.windows()
for w in wins:
    try:
        title = w.window_text()
        cls = w.class_name()
        r = w.rectangle()
        print(f"hwnd=0x{w.handle:X} cls={cls} rect=[{r.left},{r.top},{r.right},{r.bottom}] vis={w.is_visible()} title={title!r}")
    except Exception as e:
        print(f"err: {e}")
