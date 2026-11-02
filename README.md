# harpa

a customizable (kinda) cozy lo-fi screen for Hack Club Haven. meant for projectors!
also it has a dancing pudding for everyone to enjoy (you can disable this in settings but why would anyone do that?)!!

## running it

```sh
npm install
npm run dev
```

you'll need node 22.17+.

## onboarding

the first time you open it, it asks for your haven's logo and a soundcloud playlist. skip whatever you want. it all saves in that browser, so set it up on the laptop hooked to the projector. wiggle the mouse and a gear shows up top right if you want to change stuff later.

edits to the soundcloud playlist show up on the site within a minute or so. your keyboard's play/pause/skip keys work too.

can't use soundcloud? open settings and hit "use your own mp3s instead" to upload a zip of mp3s. upload them on the laptop hooked to the projector since they are only stored locally.

## deploying

```sh
npm run build
rm -rf docs && cp -R build docs
```
