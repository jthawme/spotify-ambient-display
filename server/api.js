import { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { Router } from 'express';

import * as Types from './types.js';
import { memo } from './memo.js';
import { events } from './events.js';
import { asyncInterval } from './utils.js';
import { Server } from 'socket.io';

/** @type {Types.ApiOptions} */
const DEFAULT_OPTS = {
	market: 'GB',
	searchQueryLimit: 10,
	centralisedPolling: true,
	centralisedPollingTimer: 5000
};

/**
 *
 * @param {string} id
 * @param {string} name
 * @param {string} subtitle
 * @param {string} uri
 * @param {{url: string, width: number, height: number}[]} images
 * @returns {Types.ApiNormalisedItem}
 */
const normalisedData = (id, name, subtitle, uri, images) => ({
	id,
	title: name,
	subtitle,
	uri: uri,
	image: {
		full: images.at(0),
		low: images.at(-1)
	}
});

const trim = {
	/**
	 *
	 * @param {import('@spotify/web-api-ts-sdk').Track} track
	 * @returns {Types.ApiTrackItem}
	 */
	track(track) {
		return {
			id: track.id,
			normalised: normalisedData(
				track.id,
				track.name,
				track.artists[0].name,
				track.uri,
				track?.album?.images ?? []
			),
			title: track.name,
			album: track.album.name,
			artist: track.artists[0].name,
			artists: track.artists.map((artist) => artist.name),
			number: track.track_number,
			uri: track.uri,
			image: {
				full: track.album.images.at(0),
				low: track.album.images.at(-1)
			}
		};
	},
	/**
	 *
	 * @param {import('@spotify/web-api-ts-sdk').Playlist} playlist
	 * @returns {Types.ApiPlaylistItem}
	 */
	playlist(playlist) {
		return {
			id: playlist.id,
			normalised: normalisedData(
				playlist.id,
				playlist.name,
				playlist.owner.display_name,
				playlist.uri,
				playlist.images
			),
			title: playlist.name,
			owner: playlist.owner.display_name,
			total: playlist.tracks.total,
			uri: playlist.uri,
			image: {
				full: playlist.images.at(0),
				low: playlist.images.at(-1)
			}
		};
	},
	/**
	 *
	 * @param {import('@spotify/web-api-ts-sdk').Artist} artist
	 * @returns {Types.ApiArtistItem}
	 */
	artist(artist) {
		return {
			id: artist.id,
			normalised: normalisedData(artist.id, artist.name, '', artist.uri, artist.images),
			title: artist.name,
			uri: artist.uri,
			image: {
				full: artist.images.at(0),
				low: artist.images.at(-1)
			}
		};
	},
	/**
	 *
	 * @param {import('@spotify/web-api-ts-sdk').Album} album
	 * @returns {Types.ApiAlbumItem}
	 */
	album(album) {
		return {
			normalised: normalisedData(
				album.id,
				album.name,
				album.release_date.split('-').shift(),
				album.uri,
				album.images
			),
			id: album.id,
			title: album.name,
			release: album.release_date,
			uri: album.uri,
			total: album.total_tracks,
			image: {
				full: album.images.at(0),
				low: album.images.at(-1)
			}
		};
	},
	/**
	 *
	 * @param {import('@spotify/web-api-ts-sdk').Episode} episode
	 * @returns {Types.ApiEpisodeItem}
	 */
	episode(episode) {
		return {
			id: episode.id,
			normalised: normalisedData(
				episode.id,
				episode.name,
				episode.show.name,
				episode.uri,
				episode.images
			),
			title: episode.name,
			show: episode.show.name,
			release: episode.release_date,
			uri: episode.uri,
			image: {
				full: episode.images.at(0),
				low: episode.images.at(-1)
			}
		};
	},
	/**
	 *
	 * @param {import('@spotify/web-api-ts-sdk').Show} show
	 * @returns {Types.ApiShowItem}
	 */
	show(show) {
		return {
			id: show.id,
			normalised: normalisedData(show.id, show.name, '', show.uri, show.images),
			title: show.name,
			uri: show.uri,
			image: {
				full: show.images.at(0),
				low: show.images.at(-1)
			}
		};
	}
};

/**
 *
 * @param {string} uri Spotify URI
 */
const deconstructUri = (uri) => {
	const [_, type, id] = uri.split(':');

	return {
		type,
		id
	};
};

/**
 *
 * @param {SpotifyApi} sdk
 * @param {string} uri
 * @return {Promise<Types.ApiContext | {}>}
 */
const getContext = async (sdk, uri) => {
	const { type, id } = deconstructUri(uri);

	try {
		switch (type) {
			case 'playlist': {
				const playlist = await sdk.playlists.getPlaylist(id);

				return {
					...trim.playlist(playlist),
					type: 'playlist'
				};
			}
			case 'artist': {
				const artist = await sdk.artists.get(id);

				return {
					...trim.artist(artist),
					type: 'artist'
				};
			}
			case 'album': {
				const album = await sdk.albums.get(id);

				return {
					...trim.album(album),
					type: 'album'
				};
			}
			case 'show': {
				const show = await sdk.shows.get(id);

				return {
					...trim.show(show),
					type: 'show'
				};
			}
			default: {
				return {};
			}
		}
	} catch (e) {
		return {};
	}
};

/**
 *
 * @param {(req: import('express').Request & {sdk: SpotifyApi}, res: import('express').Response, next: import('express').NextFunction)} handler
 * @returns
 */
function apiWrapper(handler) {
	return async (
		/** @type {import('express').Request & {sdk: SpotifyApi}} */ req,
		/** @type {import('express').Response} */ res,
		next
	) => {
		try {
			await handler(req, res);
		} catch (e) {
			console.error('API Error', e);
			// req.comms.error('Check Logs');
			next(e);
		}
	};
}

const SpotifyRegExp = new RegExp(
	/https?:\/\/(?:embed\.|open\.)(?:spotify\.com\/)(?:(track|album|artist)\/|\?uri=spotify:(track|album|artist):)((\w|-){22})/
);

function isSpotifyUrl(url) {
	return SpotifyRegExp.test(url);
}

function SpotifyUrl(url) {
	const [_, typeOne, typeTwo, id] = SpotifyRegExp.exec(url);

	return {
		type: typeOne || typeTwo,
		id
	};
}

export const SpotifyInteract = {
	artist: {
		/**
		 *
		 * @param {SpotifyApi} sdk
		 * @param {string} id
		 */
		async topTracks(sdk, id) {
			/** @type {import('@spotify/web-api-ts-sdk').TopTracksResult} */
			const results = await memo.use(memo.key('artist', 'tracks', id), () =>
				sdk.artists.topTracks(id)
			);

			return {
				tracks: results.tracks.map(trim.track)
			};
		}
	},

	album: {
		/**
		 *
		 * @param {SpotifyApi} sdk
		 * @param {string} id
		 */
		async get(sdk, id) {
			/** @type {import('@spotify/web-api-ts-sdk').Album} */
			const album = await memo.use(memo.key('album', id), () => sdk.albums.get(id));

			return {
				tracks: album.tracks.items
					.map((item) => ({
						...item,
						album: album
					}))
					.map(trim.track)
			};
		}
	},

	track: {
		/**
		 *
		 * @param {SpotifyApi} sdk
		 * @param {string} id
		 */
		async get(sdk, id) {
			/** @type {import('@spotify/web-api-ts-sdk').Track} */
			const track = await memo.use(memo.key('track', id), () => sdk.tracks.get(id));

			return {
				tracks: [trim.track(track)]
			};
		}
	},

	queue: {
		/**
		 *
		 * @param {SpotifyApi} sdk
		 */
		async get(sdk) {
			const queue = await sdk.player.getUsersQueue();

			if (!queue) {
				return {
					noQueue: true
				};
			}

			return {
				items: [queue.currently_playing, ...queue.queue]
					.filter((item) => !!item)
					.filter((item) => !['episode', 'track'].includes(item.type))
					.map((item) => {
						switch (item.type) {
							case 'episode':
								return trim.episode(item);
							default:
								return trim.track(item);
						}
					})
			};
		},

		/**
		 *
		 * @param {SpotifyApi} sdk
		 * @param {string} uri
		 */
		async add(sdk, uri) {
			const { queue } = await sdk.player.getUsersQueue();

			// Check if the item the user is trying to add is already in the queue
			if (queue.some((item) => item.uri === uri)) {
				return {
					success: false
				};
			}

			await sdk.player.addItemToPlaybackQueue(uri);

			return {
				success: true
			};
		}
	},

	search: {
		/**
		 *
		 * @param {SpotifyApi} sdk
		 * @param {string} q
		 * @param {import('@spotify/web-api-ts-sdk').Market} q
		 * @param {number} q
		 */
		async query(
			sdk,
			q,
			market = DEFAULT_OPTS.market,
			searchQueryLimit = DEFAULT_OPTS.searchQueryLimit
		) {
			const results = await memo.use(memo.key('search', q), () =>
				sdk.search(q, ['track', 'artist', 'album'], market, searchQueryLimit)
			);

			return {
				albums: results.albums.items.map(trim.album),
				artists: results.artists.items.map(trim.artist),
				tracks: results.tracks.items.map(trim.track)
			};
		}
	},

	context: {
		/**
		 *
		 * @param {SpotifyApi} sdk
		 */
		async get(sdk, uri) {
			/** @type {Types.ApiContext | {}} */
			const context = await memo.use(uri, () => getContext(sdk, uri));

			return context;
		}
	},

	info: {
		/**
		 *
		 * @param {SpotifyApi} sdk
		 * @param {import('@spotify/web-api-ts-sdk').Market} [market]
		 */
		async get(sdk, market = DEFAULT_OPTS.market) {
			const track = await sdk.player.getCurrentlyPlayingTrack(market, 'episode');

			if (!track) {
				return {
					noTrack: true
				};
			}

			const context = await SpotifyInteract.context.get(sdk, track.context.uri);

			return {
				isPlaying: track.is_playing,
				track:
					track.currently_playing_type === 'episode'
						? trim.episode(track.item)
						: trim.track(track.item),
				context,
				player: {
					current: track.progress_ms,
					duration: track.item.duration_ms
				}
			};
		}
	},

	player: {
		/**
		 *
		 * @param {SpotifyApi} sdk
		 */
		async play(sdk) {
			await sdk.player.startResumePlayback();

			return { success: true };
		},
		/**
		 *
		 * @param {SpotifyApi} sdk
		 */
		async pause(sdk) {
			await sdk.player.pausePlayback();

			return { success: true };
		},
		/**
		 *
		 * @param {SpotifyApi} sdk
		 */
		async forward(sdk) {
			await sdk.player.skipToNext();

			return { success: true };
		},
		/**
		 *
		 * @param {SpotifyApi} sdk
		 */
		async back(sdk) {
			await sdk.player.skipToPrevious();

			return { success: true };
		}
	}
};

/**
 *
 * @param {Server} io
 * @param {{current: SpotifyApi | null}} sdk
 * @param {Types.ApiOptions} opts
 */
const run = (io, sdk, opts = {}) => {
	const options = {
		...DEFAULT_OPTS,
		...opts
	};

	const app = Router();

	app.get(
		'/artist/:id',
		apiWrapper(async (req, res) => {
			const response = await SpotifyInteract.artist.topTracks(req.sdk, req.params.id);
			return res.json(response);
		})
	);

	app.get(
		'/album/:id',
		apiWrapper(async (req, res) => {
			const response = await SpotifyInteract.album.get(req.sdk, req.params.id);
			return res.json(response);
		})
	);

	app.get(
		'/search',
		apiWrapper(async (req, res) => {
			// Special case for handling if someone has posted a Spotify URL into the search box
			if (isSpotifyUrl(req.query.q)) {
				const { type, id } = SpotifyUrl(req.query.q);

				switch (type) {
					case 'track': {
						const response = await SpotifyInteract.track.get(req.sdk, id);
						return res.json(response);
					}
					case 'artist': {
						const response = await SpotifyInteract.artist.topTracks(req.sdk, id);
						return res.json(response);
					}
					case 'album': {
						const response = await SpotifyInteract.album.get(req.sdk, id);
						return res.json(response);
					}
				}
			}

			const response = await SpotifyInteract.search.query(
				req.sdk,
				req.query.q,
				options.market,
				options.searchQueryLimit
			);
			return res.json(response);
		})
	);

	app.get(
		'/add',
		apiWrapper(async (req, res) => {
			const { success } = await SpotifyInteract.queue.add(req.sdk, req.query.uri);

			if (!success) {
				req.comms.error('Song already in queue');
			} else {
				req.comms.message(`Added <em>${req.query.name ?? 'a track'}</em>`, 'track');
			}
			events.system('add');

			return res.json({ success });
		})
	);

	app.get(
		'/info',
		apiWrapper(async (req, res) => {
			const response = await SpotifyInteract.info.get(req.sdk, options.market);
			return res.json(response);
		})
	);

	app.get(
		'/queue',
		apiWrapper(async (req, res) => {
			const response = await SpotifyInteract.queue.get(req.sdk);
			return res.json(response);
		})
	);

	app.get(
		'/skipForward',
		apiWrapper(async (req, res) => {
			const response = await SpotifyInteract.player.forward(req.sdk);

			req.comms.message('Skipped forward');
			events.system('skippedForward');

			return res.json(response);
		})
	);

	app.get(
		'/skipBackward',
		apiWrapper(async (req, res) => {
			const response = await SpotifyInteract.player.back(req.sdk);

			req.comms.message('Skipped back');
			events.system('skippedBackward');

			return res.json(response);
		})
	);

	app.get(
		'/play',
		apiWrapper(async (req, res) => {
			const response = await SpotifyInteract.player.play(req.sdk);

			req.comms.message('Pressed play');
			events.system('play');

			return res.json(response);
		})
	);

	app.get(
		'/pause',
		apiWrapper(async (req, res) => {
			const response = await SpotifyInteract.player.pause(req.sdk);

			req.comms.message('Pressed pause');
			events.system('pause');

			return res.json(response);
		})
	);

	app.get('/health', (req, res) => res.json({ success: true, authenticated: !!req.sdk }));

	if (options.centralisedPolling) {
		asyncInterval(async () => {
			console.log('Running centralised polling');
			if (!sdk.current) {
				return;
			}

			// If there are no clients, don't bother using an API call
			if (io.engine.clientsCount > 0) {
				const info = await SpotifyInteract.info.get(sdk.current);
				io.emit('info', info);
				console.log('Ran centralised polling');
			}
		}, options.centralisedPollingTimer);
	}

	return app;
};

export default run;
