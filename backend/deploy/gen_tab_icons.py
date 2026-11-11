# -*- coding: utf-8 -*-
"""生成 tabBar 图标：81x81 PNG，4x 超采样抗锯齿"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "miniprogram", "images", "tab")
os.makedirs(OUT, exist_ok=True)

S = 4          # 超采样倍数
SIZE = 81      # 最终尺寸
CANVAS = SIZE * S

GRAY = (176, 156, 140, 255)   # #B09C8C
ORANGE = (240, 123, 63, 255)  # #F07B3F
W = (0, 0, 0, 0)              # 透明

def canvas():
    img = Image.new("RGBA", (CANVAS, CANVAS), W)
    return img, ImageDraw.Draw(img)

def save(img, name):
    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    img.save(os.path.join(OUT, name))
    print("saved", name)

def rr(d, box, r, fill):
    d.rounded_rectangle(box, radius=r, fill=fill)

# ---------- 任务：小房子 ----------
def house(color, name):
    img, d = canvas()
    # 屋顶（三角）
    d.polygon([(40.5*S, 10*S), (6*S, 42*S), (75*S, 42*S)], fill=color)
    # 屋顶圆角顶点柔和：叠一个小圆
    d.ellipse([(34.5*S, 4*S), (46.5*S, 16*S)], fill=color)
    # 房身
    rr(d, [(16*S, 40*S), (65*S, 70*S)], 8*S, color)
    # 门（镂空）
    d.rounded_rectangle([(33*S, 50*S), (48*S, 70*S)], radius=6*S, fill=W)
    save(img, name)

# ---------- 宠物：爪印 ----------
def paw(color, name):
    img, d = canvas()
    # 主肉垫
    d.ellipse([(22*S, 44*S), (59*S, 72*S)], fill=color)
    # 四个脚趾
    toes = [(12, 34), (27, 22), (46, 22), (61, 34)]
    for (x, y) in toes:
        d.ellipse([(x*S-6*S, y*S-8*S), (x*S+6*S, y*S+8*S)], fill=color)
    save(img, name)

# ---------- 记录：小本子 ----------
def book(color, name):
    img, d = canvas()
    rr(d, [(14*S, 14*S), (67*S, 68*S)], 10*S, color)
    # 书脊镂空竖线
    d.rounded_rectangle([(37.5*S, 14*S), (43.5*S, 68*S)], radius=3*S, fill=W)
    # 两页上各一条镂空短横线（像文字行）
    d.rounded_rectangle([(21*S, 30*S), (33*S, 35*S)], radius=2.5*S, fill=W)
    d.rounded_rectangle([(48*S, 30*S), (60*S, 35*S)], radius=2.5*S, fill=W)
    d.rounded_rectangle([(21*S, 44*S), (33*S, 49*S)], radius=2.5*S, fill=W)
    d.rounded_rectangle([(48*S, 44*S), (60*S, 49*S)], radius=2.5*S, fill=W)
    save(img, name)

# ---------- 我的：笑脸 ----------
def face(color, name):
    img, d = canvas()
    # 脸轮廓（粗环）
    d.ellipse([(12*S, 12*S), (69*S, 69*S)], fill=color)
    d.ellipse([(18*S, 18*S), (63*S, 63*S)], fill=W)
    # 眼睛
    d.ellipse([(28*S, 32*S), (34*S, 40*S)], fill=color)
    d.ellipse([(47*S, 32*S), (53*S, 40*S)], fill=color)
    # 微笑（弧线：用两个椭圆差集近似）
    d.pieslice([(27*S, 36*S), (54*S, 58*S)], start=15, end=165, fill=color)
    d.pieslice([(31*S, 40*S), (50*S, 54*S)], start=10, end=170, fill=W)
    save(img, name)

for c, tag in [(GRAY, ""), (ORANGE, "-selected")]:
    house(c, f"task{tag}.png")
    paw(c, f"pets{tag}.png")
    book(c, f"history{tag}.png")
    face(c, f"profile{tag}.png")

print("done ->", os.path.abspath(OUT))
