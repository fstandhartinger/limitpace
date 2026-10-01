#!/usr/bin/env python3
"""Render SGR ANSI text captures with Pillow; no browser or network needed."""
import re
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
COLORS = {30:'#181a20',31:'#f16d7a',32:'#79cd9c',33:'#ecc578',34:'#79aaf2',35:'#c99cea',36:'#7bc8d5',37:'#e2e6ed',90:'#818b9c',91:'#f16d7a',92:'#79cd9c',93:'#ecc578',94:'#79aaf2',95:'#c99cea',96:'#7bc8d5',97:'#f7f8fa'}
BG='#171b24'
font=ImageFont.truetype(REGULAR,16); boldfont=ImageFont.truetype(BOLD,16)
cell=font.getlength('M'); lineheight=25
for arg in sys.argv[1:]:
    src=Path(arg); raw=src.read_text().rstrip()+'\n'
    plain=re.sub(r'\x1b\[[0-9;]*m','',raw)
    lines=plain.splitlines()
    width=round(max((len(s) for s in lines),default=1)*cell)+48
    height=len(lines)*lineheight+40
    img=Image.new('RGB',(width,height),BG); draw=ImageDraw.Draw(img)
    color=COLORS[37]; bold=False; dim=False; x=24; y=18
    for piece in re.split(r'(\x1b\[[0-9;]*m)',raw):
        if piece.startswith('\x1b['):
            nums=[int(n) for n in piece[2:-1].split(';') if n] or [0]
            i=0
            while i<len(nums):
                n=nums[i]
                if n==0: color=COLORS[37]; bold=False; dim=False
                elif n==1: bold=True
                elif n==2: dim=True
                elif n==22: bold=False; dim=False
                elif n==39: color=COLORS[37]
                elif n in COLORS: color=COLORS[n]
                elif n==38 and i+4<len(nums) and nums[i+1]==2:
                    color='#%02x%02x%02x'%tuple(nums[i+2:i+5]); i+=4
                elif n==38 and i+2<len(nums) and nums[i+1]==5:
                    idx=nums[i+2]
                    if idx<16: color=list(COLORS.values())[idx%16]
                    elif idx<232:
                        r,g,b=(idx-16)//36,((idx-16)//6)%6,(idx-16)%6
                        values=[0,95,135,175,215,255]; color='#%02x%02x%02x'%(values[r],values[g],values[b])
                    else: val=8+(idx-232)*10; color='#%02x%02x%02x'%(val,val,val)
                    i+=2
                i+=1
            continue
        for char in piece:
            if char=='\n': x=24; y+=lineheight; continue
            if char=='\r': continue
            fill=color
            if dim:
                rgb=tuple(int(color[j:j+2],16) for j in (1,3,5)); back=(23,27,36)
                fill=tuple(round(a*.6+b*.4) for a,b in zip(rgb,back))
            draw.text((round(x),y),char,font=boldfont if bold else font,fill=fill)
            x+=cell
    target=src.with_suffix('.png'); img.save(target)
    print(f'{src} -> {target} ({width}x{height})')
